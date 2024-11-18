/**
 * A module responsible for combining ingested configuration data
 * into a single object that defines the filters available on a page,
 * validating the data in the process.
 */

import { FilterOptionsConfig } from '../schemas/yaml/filterOptions';
import { GLOBAL_PLACEHOLDER_REGEX } from '../schemas/regexes';
import { Frontmatter } from '../schemas/yaml/frontMatter';
import { Allowlist } from '../schemas/yaml/allowlist';
import { PLACEHOLDER_REGEX } from '../schemas/regexes';
import {
  PageFiltersManifest,
  PageFiltersClientSideManifest
} from '../schemas/pageFilters';
import { PageFilterConfig } from '../schemas/yaml/frontMatter';

/**
 * A module responsible for all data ingestion from
 * the YAML files that define the available filters
 * and their options.
 */
export class FiltersManifestBuilder {
  /**
   * Convert a standard compile-time page filters manifest
   * to a lighter version to be used client-side.
   */
  static minifyManifest(manifest: PageFiltersManifest): PageFiltersClientSideManifest {
    const result: PageFiltersClientSideManifest = {
      filtersById: {},
      defaultValsByFilterId: { ...manifest.defaultValsByFilterId },
      optionSetsById: { ...manifest.optionSetsById }
    };

    Object.keys(manifest.filtersById).forEach((filterId) => {
      const filter = manifest.filtersById[filterId];
      result.filtersById[filterId] = {
        config: { ...filter.config },
        defaultValsByOptionsSetId: { ...filter.defaultValsByOptionsSetId }
      };
    });

    return result;
  }
  /**
   * Collect all possible default values,
   * and all possible selected values,
   * for a given list of options set IDs.
   */
  static getPossibleDefaultsAndSelectedValues(p: {
    filterId: string;
    optionsSetIds: string[];
    allowlist: Allowlist;
    filterOptionsConfig: FilterOptionsConfig;
  }): {
    defaultValsByOptionsSetId: Record<string, string>;
    possibleVals: string[];
    errors: string[];
  } {
    // Populate the default value for each options set ID
    const defaultValsByOptionsSetId: Record<string, string> = {};
    const possibleVals: string[] = [];
    const errors: string[] = [];

    p.optionsSetIds.forEach((optionsSetId) => {
      const optionsSet = p.filterOptionsConfig[optionsSetId];
      if (!optionsSet) {
        errors.push(
          `Invalid options source: The options source '${optionsSetId}', which is required for the filter ID '${p.filterId}', does not exist.`
        );
        return;
      }

      optionsSet.forEach((option) => {
        if (!p.allowlist.optionsById[option.id]) {
          errors.push(
            `Invalid option ID: The option ID '${option.id}' is not in the options allowlist.`
          );
        }

        if (option.default) {
          defaultValsByOptionsSetId[optionsSetId] = option.id;
        }

        possibleVals.push(option.id);
      });
    });

    return { defaultValsByOptionsSetId, possibleVals, errors };
  }

  /**
   * For filters whose options source contains placeholders,
   * build all possible options set IDs that could be referenced
   * by the filter, based on the preceding filters.
   */
  static buildDynamicOptionsSetIds(p: {
    filterId: string;
    filterOptionsConfig: FilterOptionsConfig;
    filterConfigsByFilterId: Record<string, PageFilterConfig>;
    precedingFilterIds: string[];
  }): { optionsSetIds: string[]; errors: string[] } {
    const filter = p.filterConfigsByFilterId[p.filterId];

    let optionsSetIds: string[] = [];
    const errors: string[] = [];

    const segments = filter.options_source.split('_').map((segment) => {
      // build non-placeholder segment (array of solitary possible value)
      if (!segment.match(PLACEHOLDER_REGEX)) {
        return [segment];
      }

      // build placeholder segment (array of all possible values)
      const referencedFilterId = segment.slice(1, -1).toLowerCase();
      const referencedFilterConfig = p.filterConfigsByFilterId[referencedFilterId];
      if (!referencedFilterConfig || !p.precedingFilterIds.includes(referencedFilterId)) {
        errors.push(
          `Invalid placeholder: The placeholder ${segment} in the options source '${filter.options_source}' refers to an unrecognized filter ID. The file frontmatter must contain a filter with the ID '${referencedFilterId}', and it must be defined before the filter with the ID ${filter.id}.`
        );
        return [segment];
      }

      const referencedOptionsSet =
        p.filterOptionsConfig[referencedFilterConfig.options_source];

      return referencedOptionsSet.map((option) => option.id);
    });

    // Only finish building the options set IDs if there are no errors,
    // to avoid generating invalid options set IDs
    if (errors.length === 0) {
      optionsSetIds = this.buildSnakeCaseCombinations(segments);
    } else {
      optionsSetIds = [];
    }

    return { optionsSetIds, errors };
  }

  /**
   * Derive the default values for each filter,
   * and return them keyed by filter ID.
   */
  static getDefaultValsByFilterId(p: {
    filterOptionsConfig: FilterOptionsConfig;
    filterConfigs: PageFilterConfig[];
  }): Record<string, string> {
    const defaultValsByFilterId: Record<string, string> = {};

    // Process each entry in the frontmatter's content_filters list
    for (const fmFilterConfig of p.filterConfigs) {
      // Replace any placeholders in the options source
      const optionsSetId = fmFilterConfig.options_source;
      const resolvedOptionsSetId = optionsSetId.replace(
        GLOBAL_PLACEHOLDER_REGEX,
        (_match: string, placeholder: string) => {
          const value = defaultValsByFilterId[placeholder.toLowerCase()];
          return value || '';
        }
      );

      // Resolve the default option set for this filter
      const resolvedOptionSet = p.filterOptionsConfig[resolvedOptionsSetId];

      if (resolvedOptionSet) {
        defaultValsByFilterId[fmFilterConfig.id] =
          fmFilterConfig.default_value ||
          resolvedOptionSet.find((option) => option.default)!.id;
      }
    }

    return defaultValsByFilterId;
  }

  /**
   * Combine a page's frontmatter, the global allowlist,
   * and the global filter config into a single object
   * that defines the filters available on the page.
   */
  static build(p: {
    frontmatter: Frontmatter;
    filterOptionsConfig: FilterOptionsConfig;
    allowlist: Allowlist;
  }): PageFiltersManifest {
    // Create an empty manifest to populate
    const manifest: PageFiltersManifest = {
      filtersById: {},
      optionSetsById: {},
      errors: [],
      defaultValsByFilterId: {}
    };

    // Return the empty manifest if the page has no filters
    if (!p.frontmatter.content_filters) {
      return manifest;
    }

    // Collect default values for each filter, keyed by filter ID,
    // used to resolve placeholders in options sources
    manifest.defaultValsByFilterId = this.getDefaultValsByFilterId({
      filterOptionsConfig: p.filterOptionsConfig,
      filterConfigs: p.frontmatter.content_filters
    });

    // Key the configs by filter ID, for convenient access during processing
    const filterConfigByFilterId: Record<string, PageFilterConfig> =
      p.frontmatter.content_filters.reduce(
        (obj, filterConfig) => ({ ...obj, [filterConfig.id]: filterConfig }),
        {}
      );

    // Keep track of the filter IDs that have been processed,
    // to ensure correct definition order in frontmatter
    const processedFilterIds: string[] = [];

    // Fill out the manifest for each filter,
    // in the order that the filters appeared in the frontmatter
    p.frontmatter.content_filters.forEach((pageFilterConfig) => {
      // Validate the filter ID
      if (!p.allowlist.filtersById[pageFilterConfig.id]) {
        manifest.errors.push(
          `Unrecognized filter ID: The filter ID '${pageFilterConfig.id}' is not in the allowlist.`
        );
      }

      // Get all possible options set IDs for this filter,
      // so each one can have its range of values processed
      // and the options set itself can be attached to the manifest
      let optionsSetIds: string[] = [];
      const hasDynamicOptions = pageFilterConfig.options_source.match(PLACEHOLDER_REGEX);

      if (hasDynamicOptions) {
        const { optionsSetIds: dynamicOptionsSetIds, errors } =
          this.buildDynamicOptionsSetIds({
            filterId: pageFilterConfig.id,
            filterOptionsConfig: p.filterOptionsConfig,
            filterConfigsByFilterId: filterConfigByFilterId,
            precedingFilterIds: processedFilterIds
          });

        if (errors.length > 0) {
          manifest.errors.push(...errors);
        }

        optionsSetIds = dynamicOptionsSetIds;
      } else {
        optionsSetIds = [pageFilterConfig.options_source];
      }

      // Collect a default value for every possible options set ID,
      // along with all possible selected values for the filter
      const { defaultValsByOptionsSetId, possibleVals, errors } =
        this.getPossibleDefaultsAndSelectedValues({
          filterId: pageFilterConfig.id,
          optionsSetIds,
          allowlist: p.allowlist,
          filterOptionsConfig: p.filterOptionsConfig
        });

      if (errors.length > 0) {
        manifest.errors.push(...errors);
      }

      manifest.filtersById[pageFilterConfig.id] = {
        config: pageFilterConfig,
        defaultValsByOptionsSetId: defaultValsByOptionsSetId,
        possibleVals: possibleVals
      };

      processedFilterIds.push(pageFilterConfig.id);
    });

    // Attach any options sets that were referenced by the filters
    Object.keys(manifest.filtersById).forEach((filterId) => {
      const filterManifest = manifest.filtersById[filterId];
      const optionsSetIds = Object.keys(filterManifest.defaultValsByOptionsSetId);
      optionsSetIds.forEach((optionsSetId) => {
        if (!manifest.optionSetsById[optionsSetId]) {
          manifest.optionSetsById[optionsSetId] = p.filterOptionsConfig[optionsSetId];
        }
      });
    });

    return manifest;
  }

  /**
   * When given arrays of the segments of a potential snake_case string,
   * generate all possible combinations of the segments in snake_case.
   *
   * @param {any[]} arr An array of arrays of strings. Each array represents
   * a set of possible values for a segment of a snake_case string.
   * @returns {string[]} An array of all possible snake_case combinations.
   *
   * @example
   * const segments = [['red', 'blue'], ['gloss', 'matte'], ['paint'], ['options']];
   * FiltersManifestBuilder.buildSnakeCaseCombinations(segments);
   * // returns ['red_gloss_paint_options', 'red_matte_paint_options', 'blue_gloss_paint_options', 'blue_matte_paint_options']
   */
  static buildSnakeCaseCombinations(arr: any[], str: string = '', final: any[] = []) {
    if (arr.length > 1) {
      arr[0].forEach((segment: string) =>
        this.buildSnakeCaseCombinations(
          arr.slice(1),
          str + (str === '' ? '' : '_') + segment,
          final
        )
      );
    } else {
      arr[0].forEach((segment: string) =>
        final.push(str + (str === '' ? '' : '_') + segment)
      );
    }
    return final;
  }
}
