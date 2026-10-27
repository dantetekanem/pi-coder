import { describe, expect, it } from "vitest";
import { parsePiCoderSettings } from "../provider-settings.js";
import { createReviewSourceLinks } from "../source-links.js";
import { normalizeExternalUrl } from "../ui/open-url.js";

const settings = parsePiCoderSettings({
  search: "https://search.example/results?q=sym:{query}",
  providers: {
    host: {
      label: "Code host",
      executable: "host-cli",
      urls: {
        patterns: [{ host: "code.example", path: "/{repo}/pull/{number}" }],
        canonical: "https://code.example/{repo}/pull/{number}",
        file: "https://code.example/{repo}/blob/{revision}/{path}#L{line}",
      },
      operations: {},
    },
  },
});

describe("createReviewSourceLinks", () => {
  it("renders file and search links that the browser opener accepts", () => {
    const links = createReviewSourceLinks(settings, settings.providers.host, "team/app");
    const revision = "f".repeat(40);
    const file = links.file?.({ path: "src/a b/(draft)*.rb", revision, line: 12 });
    expect(file).toBe(`https://code.example/team/app/blob/${revision}/src/a%20b/%28draft%29%2A.rb#L12`);
    expect(normalizeExternalUrl(file)).toBe(file);
    const search = links.search?.("save!");
    expect(search).toBe("https://search.example/results?q=sym:save%21");
    expect(normalizeExternalUrl(search)).toBe(search);
  });

  it("offers only links whose template and repository are known", () => {
    expect(Object.keys(createReviewSourceLinks(settings, settings.providers.host))).toEqual(["search"]);
    expect(createReviewSourceLinks({}, settings.providers.github, "team/app")).toEqual({});
  });
});
