import { renderProviderTemplate, type PiCodeDiffSettings, type ProviderSettings } from "./provider-settings.js";

export interface ReviewSourceLocation {
  path: string;
  revision: string;
  line: number;
}

/** Browser links for reviewed code, available only when their URL templates are configured. */
export interface ReviewSourceLinks {
  file?: (location: ReviewSourceLocation) => string;
  search?: (query: string) => string;
}

// Stricter than encodeURIComponent because the URL opener refuses ! ' ( ) and *.
function encodeUrlComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeUrlPath(value: string): string {
  return value.split("/").map(encodeUrlComponent).join("/");
}

export function createReviewSourceLinks(
  settings: Pick<PiCodeDiffSettings, "search">,
  provider?: ProviderSettings,
  repo?: string,
): ReviewSourceLinks {
  const fileTemplate = provider?.urls.file;
  const repoPath = repo == null ? undefined : encodeUrlPath(repo);
  const searchTemplate = settings.search;
  return {
    ...(fileTemplate == null || repoPath == null ? {} : {
      file: ({ path, revision, line }: ReviewSourceLocation) => renderProviderTemplate(fileTemplate, {
        repo: repoPath,
        revision: encodeUrlComponent(revision),
        path: encodeUrlPath(path),
        line,
      }),
    }),
    ...(searchTemplate == null ? {} : {
      search: (query: string) => renderProviderTemplate(searchTemplate, { query: encodeUrlComponent(query) }),
    }),
  };
}
