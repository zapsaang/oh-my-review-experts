import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseReviewScope, ScopeResolutionError, AmbiguousScopeError } from "../../src/workflow/scope-resolver.js";
import {
  withCleanGitRepo,
  withRepoOnBranch,
  withRepoWithBranches,
} from "../_helpers/fixture-repo.js";

describe("parseReviewScope", () => {
  describe("T6: empty / guidance / staged", () => {
    it("returns default scope for empty string", () => {
      expect(parseReviewScope("", "/tmp")).toEqual({ kind: "default" });
    });

    it("returns default scope for whitespace-only input", () => {
      expect(parseReviewScope("   ", "/tmp")).toEqual({ kind: "default" });
      expect(parseReviewScope("\t\n", "/tmp")).toEqual({ kind: "default" });
    });

    it("recognises bare `staged` keyword", () => {
      expect(parseReviewScope("staged", "/tmp")).toEqual({ kind: "staged" });
    });

    it("recognises `--staged` flag", () => {
      expect(parseReviewScope("--staged", "/tmp")).toEqual({ kind: "staged" });
    });

    it("recognises `--cached` flag", () => {
      expect(parseReviewScope("--cached", "/tmp")).toEqual({ kind: "staged" });
    });

    it("falls through to guidance for arbitrary text", () => {
      expect(parseReviewScope("focus on security", "/tmp")).toEqual({
        kind: "guidance",
        text: "focus on security",
      });
    });

    it("trims whitespace before producing guidance", () => {
      expect(parseReviewScope("  focus on security  ", "/tmp")).toEqual({
        kind: "guidance",
        text: "focus on security",
      });
    });
  });

  describe("T7: explicit prefix forms", () => {
    describe("branch:", () => {
      it("returns branch scope for valid name", () => {
        expect(parseReviewScope("branch:feature/foo", "/tmp")).toEqual({
          kind: "branch",
          name: "feature/foo",
        });
      });

      it("accepts dotted, dashed, underscored names", () => {
        expect(parseReviewScope("branch:release-1.2_v3", "/tmp")).toEqual({
          kind: "branch",
          name: "release-1.2_v3",
        });
      });

      it("throws INVALID_INPUT on empty name", () => {
        expect(() => parseReviewScope("branch:", "/tmp")).toThrowError(
          ScopeResolutionError
        );
        try {
          parseReviewScope("branch:", "/tmp");
        } catch (err) {
          expect(err).toBeInstanceOf(ScopeResolutionError);
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
        }
      });

      it("throws INVALID_INPUT on leading dash", () => {
        expect(() => parseReviewScope("branch:-foo", "/tmp")).toThrow(
          ScopeResolutionError
        );
        try {
          parseReviewScope("branch:-foo", "/tmp");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
        }
      });

      it("throws INVALID_INPUT on disallowed characters", () => {
        expect(() => parseReviewScope("branch:foo bar", "/tmp")).toThrow(
          ScopeResolutionError
        );
        expect(() => parseReviewScope("branch:foo;rm", "/tmp")).toThrow(
          ScopeResolutionError
        );
      });
    });

    describe("commit:", () => {
      it("returns commit scope for short hex", () => {
        expect(parseReviewScope("commit:abcd", "/tmp")).toEqual({
          kind: "commit",
          ref: "abcd",
        });
      });

      it("returns commit scope for full SHA", () => {
        const sha = "0123456789abcdef0123456789abcdef01234567";
        expect(parseReviewScope(`commit:${sha}`, "/tmp")).toEqual({
          kind: "commit",
          ref: sha,
        });
      });

      it("returns commit scope for HEAD", () => {
        expect(parseReviewScope("commit:HEAD", "/tmp")).toEqual({
          kind: "commit",
          ref: "HEAD",
        });
      });

      it("returns commit scope for HEAD~3", () => {
        expect(parseReviewScope("commit:HEAD~3", "/tmp")).toEqual({
          kind: "commit",
          ref: "HEAD~3",
        });
      });

      it("returns commit scope for HEAD^", () => {
        expect(parseReviewScope("commit:HEAD^", "/tmp")).toEqual({
          kind: "commit",
          ref: "HEAD^",
        });
      });

      it("throws INVALID_INPUT on empty ref", () => {
        try {
          parseReviewScope("commit:", "/tmp");
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
        }
      });

      it("throws INVALID_INPUT on non-hex ref", () => {
        try {
          parseReviewScope("commit:zzzz", "/tmp");
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
        }
      });

      it("throws INVALID_INPUT on hex shorter than 4 chars", () => {
        try {
          parseReviewScope("commit:abc", "/tmp");
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
        }
      });
    });

    describe("path:", () => {
      it("returns paths for a single safe path", () =>
        withCleanGitRepo((cwd) => {
          fs.writeFileSync(path.join(cwd, "a.txt"), "x", "utf8");
          expect(parseReviewScope("path:a.txt", cwd)).toEqual({
            kind: "paths",
            paths: ["a.txt"],
          });
        }));

      it("returns paths for comma-separated list with trimming", () =>
        withCleanGitRepo((cwd) => {
          fs.writeFileSync(path.join(cwd, "a.txt"), "x", "utf8");
          fs.writeFileSync(path.join(cwd, "b.txt"), "y", "utf8");
          expect(parseReviewScope("path:a.txt , b.txt", cwd)).toEqual({
            kind: "paths",
            paths: ["a.txt", "b.txt"],
          });
        }));

      it("path: does not require parts to exist on disk", () => {
        const result = parseReviewScope("path:src/foo.ts", "/tmp");
        expect(result).toEqual({ kind: "paths", paths: ["src/foo.ts"] });
      });

      it("throws PATH_TRAVERSAL on `..` segment", () => {
        try {
          parseReviewScope("path:../etc/passwd", "/tmp");
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("PATH_TRAVERSAL");
        }
      });

      it("throws PATH_TRAVERSAL on absolute path", () => {
        try {
          parseReviewScope("path:/etc/passwd", "/tmp");
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("PATH_TRAVERSAL");
        }
      });

      it("throws INVALID_INPUT on empty list", () => {
        try {
          parseReviewScope("path:", "/tmp");
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
        }
      });

      it("throws INVALID_INPUT on disallowed characters", () => {
        try {
          parseReviewScope("path:foo bar.ts", "/tmp");
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
        }
      });
    });

    describe("range:", () => {
      it("returns range with `..` separator", () => {
        expect(parseReviewScope("range:main..feature", "/tmp")).toEqual({
          kind: "range",
          from: "main",
          to: "feature",
        });
      });

      it("returns range with `...` separator", () => {
        expect(parseReviewScope("range:main...feature", "/tmp")).toEqual({
          kind: "range",
          from: "main",
          to: "feature",
        });
      });

      it("accepts ~ and ^ in refs", () => {
        expect(parseReviewScope("range:HEAD~3..HEAD", "/tmp")).toEqual({
          kind: "range",
          from: "HEAD~3",
          to: "HEAD",
        });
      });

      it("throws INVALID_INPUT on missing separator", () => {
        try {
          parseReviewScope("range:mainfeature", "/tmp");
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
        }
      });

      it("throws INVALID_INPUT on empty from", () => {
        try {
          parseReviewScope("range:..feature", "/tmp");
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
        }
      });

      it("throws INVALID_INPUT on empty to", () => {
        try {
          parseReviewScope("range:main..", "/tmp");
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
        }
      });

      it("throws INVALID_INPUT on leading `-` in either ref", () => {
        try {
          parseReviewScope("range:--evil..main", "/tmp");
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
        }
      });
    });
  });

  describe("T8: bare-form SHA detection", () => {
    it("returns commit scope for an existing short SHA", () =>
      withCleanGitRepo((cwd) => {
        const sha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd,
          encoding: "utf8",
        }).trim();
        const short = sha.slice(0, 8);
        expect(parseReviewScope(short, cwd)).toEqual({
          kind: "commit",
          ref: short,
        });
      }));

    it("returns commit scope for an existing full SHA", () =>
      withCleanGitRepo((cwd) => {
        const sha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd,
          encoding: "utf8",
        }).trim();
        expect(parseReviewScope(sha, cwd)).toEqual({
          kind: "commit",
          ref: sha,
        });
      }));

    it("returns commit scope for HEAD", () =>
      withCleanGitRepo((cwd) => {
        expect(parseReviewScope("HEAD", cwd)).toEqual({
          kind: "commit",
          ref: "HEAD",
        });
      }));

    it("returns commit scope for HEAD~0 in a fresh repo", () =>
      withCleanGitRepo((cwd) => {
        expect(parseReviewScope("HEAD~0", cwd)).toEqual({
          kind: "commit",
          ref: "HEAD~0",
        });
      }));

    it("falls through to guidance for hex string that is not a real ref", () =>
      withCleanGitRepo((cwd) => {
        const fakeSha = "deadbeef".repeat(5);
        const result = parseReviewScope(fakeSha, cwd);
        expect(result.kind).toBe("guidance");
        if (result.kind === "guidance") {
          expect(result.text).toBe(fakeSha);
        }
      }));
  });

  describe("T9: bare-form branch detection", () => {
    it("recognises a local branch", () =>
      withRepoWithBranches({ "feature/foo": { "src/a.ts": "// a\n" } }, (cwd) => {
        expect(parseReviewScope("feature/foo", cwd)).toEqual({
          kind: "branch",
          name: "feature/foo",
        });
      }));

    it("recognises a remote-tracking branch", () =>
      withCleanGitRepo((cwd) => {
        const remoteRefDir = path.join(cwd, ".git", "refs", "remotes", "origin");
        fs.mkdirSync(remoteRefDir, { recursive: true });
        const sha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd,
          encoding: "utf8",
        }).trim();
        fs.writeFileSync(path.join(remoteRefDir, "develop"), `${sha}\n`, "utf8");
        expect(parseReviewScope("origin/develop", cwd)).toEqual({
          kind: "branch",
          name: "origin/develop",
        });
      }));

    it("falls through when name does not match any ref", () =>
      withCleanGitRepo((cwd) => {
        const result = parseReviewScope("nonexistent-branch", cwd);
        expect(result.kind).toBe("guidance");
      }));
  });

  describe("T10: bare-form path detection", () => {
    it("returns paths when a single file exists", () =>
      withRepoOnBranch("dev", { "src/a.ts": "// a\n" }, (cwd) => {
        expect(parseReviewScope("src/a.ts", cwd)).toEqual({
          kind: "paths",
          paths: ["src/a.ts"],
        });
      }));

    it("returns paths for comma-separated list when all exist", () =>
      withRepoOnBranch(
        "dev",
        { "src/a.ts": "// a\n", "src/b.ts": "// b\n" },
        (cwd) => {
          expect(parseReviewScope("src/a.ts,src/b.ts", cwd)).toEqual({
            kind: "paths",
            paths: ["src/a.ts", "src/b.ts"],
          });
        }
      ));

    it("trims whitespace inside comma-separated list", () =>
      withRepoOnBranch(
        "dev",
        { "src/a.ts": "// a\n", "src/b.ts": "// b\n" },
        (cwd) => {
          expect(parseReviewScope("src/a.ts , src/b.ts", cwd)).toEqual({
            kind: "paths",
            paths: ["src/a.ts", "src/b.ts"],
          });
        }
      ));

    it("falls through to guidance when none of the parts exist", () =>
      withCleanGitRepo((cwd) => {
        const result = parseReviewScope("does-not-exist.ts", cwd);
        expect(result.kind).toBe("guidance");
      }));

    it("throws INVALID_INPUT when some parts exist and some do not", () =>
      withRepoOnBranch("dev", { "src/a.ts": "// a\n" }, (cwd) => {
        try {
          parseReviewScope("src/a.ts,src/missing.ts", cwd);
          expect.fail("expected throw");
        } catch (err) {
          expect((err as ScopeResolutionError).code).toBe("INVALID_INPUT");
          expect((err as ScopeResolutionError).message).toContain("missing.ts");
        }
      }));

    it("does not interpret unsafe paths as paths (falls through)", () =>
      withCleanGitRepo((cwd) => {
        const result = parseReviewScope("foo bar.ts", cwd);
        expect(result.kind).toBe("guidance");
      }));
  });

  describe("precedence", () => {
    it("staged keyword wins over branch detection", () =>
      withRepoWithBranches({ staged: { "src/a.ts": "// a\n" } }, (cwd) => {
        expect(parseReviewScope("staged", cwd)).toEqual({ kind: "staged" });
      }));

    it("explicit branch: prefix is preferred over bare branch detection", () =>
      withCleanGitRepo((cwd) => {
        expect(parseReviewScope("branch:no-such-branch", cwd)).toEqual({
          kind: "branch",
          name: "no-such-branch",
        });
      }));

    it("bare SHA wins over bare path coincidence", () =>
      withCleanGitRepo((cwd) => {
        const sha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd,
          encoding: "utf8",
        }).trim();
        const short = sha.slice(0, 8);
        fs.writeFileSync(path.join(cwd, short), "decoy", "utf8");
        expect(parseReviewScope(short, cwd)).toEqual({
          kind: "commit",
          ref: short,
        });
      }));
  });

  describe("ambiguity detection", () => {
    it("returns ambiguous when branch and directory share a name", () =>
      withRepoWithBranches(
        { auth: { "auth/index.ts": "// auth\n" } },
        (cwd) => {
          const result = parseReviewScope("auth", cwd);
          expect(result.kind).toBe("ambiguous");
          if (result.kind === "ambiguous") {
            expect(result.candidates).toEqual([
              { kind: "branch", name: "auth" },
              { kind: "paths", paths: ["auth"] },
            ]);
          }
        }
      ));

    it("explicit branch: prefix bypasses ambiguity", () =>
      withRepoWithBranches(
        { auth: { "auth/index.ts": "// auth\n" } },
        (cwd) => {
          expect(parseReviewScope("branch:auth", cwd)).toEqual({
            kind: "branch",
            name: "auth",
          });
        }
      ));

    it("explicit path: prefix bypasses ambiguity", () =>
      withRepoWithBranches(
        { auth: { "auth/index.ts": "// auth\n" } },
        (cwd) => {
          expect(parseReviewScope("path:auth", cwd)).toEqual({
            kind: "paths",
            paths: ["auth"],
          });
        }
      ));

    it("throws PATH_TRAVERSAL on bare path with .. segment", () =>
      withCleanGitRepo((cwd) => {
        try {
          parseReviewScope("../etc", cwd);
          expect.fail("expected throw");
        } catch (err) {
          expect(err).toBeInstanceOf(ScopeResolutionError);
          expect((err as ScopeResolutionError).code).toBe("PATH_TRAVERSAL");
        }
      }));

    it("[P3] ambiguity detection survives tryBarePaths exceptions via wrapper", () =>
      withRepoWithBranches(
        { auth: { "auth/index.ts": "// auth\n" } },
        (cwd) => {
          // Both branch "auth" and path "auth" exist → ambiguous.
          // Before P3 fix, wouldBarePathsResolve had independent logic.
          // After P3 fix, it wraps tryBarePaths and catches exceptions.
          // This test guards against the wrapper leaking exceptions.
          const result = parseReviewScope("auth", cwd);
          expect(result.kind).toBe("ambiguous");
          if (result.kind === "ambiguous") {
            expect(result.candidates).toEqual([
              { kind: "branch", name: "auth" },
              { kind: "paths", paths: ["auth"] },
            ]);
          }
        }
      ));
  });
});
