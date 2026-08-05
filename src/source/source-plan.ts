import type { GitSourcePlan, SourceMode, SourcePlan } from "../model/source.ts";
import { normalizeCredentialFreeRepositoryLocator } from "./repository-locator.ts";

export const DEFAULT_DEPLOY_TAG_PREFIX = "deploy/prod";
export const DEFAULT_LOCAL_COPY_CLEANUP_PATHS = [
  "common/temp",
  ".dagger/runtime",
];
export const DEFAULT_GIT_AUTH_USERNAME = "x-access-token";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export type BuildSourcePlanInput = {
  authTokenEnv?: string;
  authUsername?: string;
  cleanupPaths?: string[];
  commitSha?: string;
  deployTagPrefix?: string;
  mode?: string;
  prBaseSha?: string;
  ref?: string;
  repositoryUrl?: string;
  removeNodeModules?: boolean;
};

function requireNonEmpty(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }

  return value;
}

function rejectShellUnsafe(value: string, name: string): string {
  if (/[\u0000-\u001f\u007f\s]/u.test(value)) {
    throw new Error(
      `${name} must not contain whitespace or control characters.`,
    );
  }

  if (value.startsWith("-")) {
    throw new Error(`${name} must not start with "-".`);
  }

  return value;
}

function parseRepoRelativePath(value: string, name: string): string {
  rejectShellUnsafe(value, name);

  if (value.startsWith("/") || value === "." || value.length === 0) {
    throw new Error(`${name} must be a repository-relative path.`);
  }

  if (value.split("/").some((segment) => segment === "..")) {
    throw new Error(`${name} must stay inside the repository.`);
  }

  return value.replace(/^\.\/+/u, "").replace(/\/+$/u, "");
}

function parseRepoRelativePaths(
  values: string[] | undefined,
  name: string,
): string[] {
  return (values ?? DEFAULT_LOCAL_COPY_CLEANUP_PATHS).map((path, index) =>
    parseRepoRelativePath(path, `${name}[${index}]`),
  );
}

function parseFullGitSha(value: string | undefined, name: string): string {
  const gitSha = rejectShellUnsafe(requireNonEmpty(value, name), name);

  if (!FULL_GIT_SHA_PATTERN.test(gitSha)) {
    throw new Error(`${name} must be a full 40-character Git SHA.`);
  }

  return gitSha.toLowerCase();
}

function parseOptionalFullGitSha(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return parseFullGitSha(value, name);
}

function parseGitRef(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const ref = rejectShellUnsafe(value, "Git source ref");

  if (ref.includes("..") || ref.endsWith(".lock")) {
    throw new Error("Git source ref is not a safe Git ref.");
  }

  return ref;
}

function parseDeployTagPrefix(value: string | undefined): string {
  const prefix = rejectShellUnsafe(
    requireNonEmpty(value ?? DEFAULT_DEPLOY_TAG_PREFIX, "Deploy tag prefix"),
    "Deploy tag prefix",
  );

  if (prefix.startsWith("/") || prefix.endsWith("/") || prefix.includes("..")) {
    throw new Error("Deploy tag prefix is not a safe tag prefix.");
  }

  return prefix;
}

function parseRepositoryUrl(value: string | undefined): string {
  const repositoryUrl = rejectShellUnsafe(
    requireNonEmpty(value, "Git source repository URL"),
    "Git source repository URL",
  );

  return normalizeCredentialFreeRepositoryLocator(
    repositoryUrl,
    "Git source repository URL",
  );
}

function parseAuthTokenEnv(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const tokenEnv = requireNonEmpty(value, "Git source auth token env");

  if (!ENV_NAME_PATTERN.test(tokenEnv)) {
    throw new Error(
      `Git source auth token env "${tokenEnv}" must match ${ENV_NAME_PATTERN}.`,
    );
  }

  return tokenEnv;
}

function parseAuthUsername(
  tokenEnv: string | undefined,
  username: string | undefined,
): string | undefined {
  if (tokenEnv === undefined) {
    if (username !== undefined && username.length > 0) {
      throw new Error(
        "Git source auth username requires Git source auth token env.",
      );
    }

    return undefined;
  }

  return rejectShellUnsafe(
    requireNonEmpty(
      username ?? DEFAULT_GIT_AUTH_USERNAME,
      "Git source auth username",
    ),
    "Git source auth username",
  );
}

export function parseSourceMode(value: string = "local_copy"): SourceMode {
  switch (value) {
    case "local_copy":
    case "git":
      return value;
    default:
      throw new Error(`Unsupported source mode "${value}".`);
  }
}

export function buildSourcePlan(input: BuildSourcePlanInput = {}): SourcePlan {
  const mode = parseSourceMode(input.mode);

  if (mode === "local_copy") {
    return {
      cleanupPaths: parseRepoRelativePaths(
        input.cleanupPaths,
        "Local copy cleanup paths",
      ),
      mode,
      removeNodeModules: input.removeNodeModules ?? true,
    };
  }

  const repositoryUrl = parseRepositoryUrl(input.repositoryUrl);
  const commitSha = parseFullGitSha(input.commitSha, "Git source commit SHA");
  const ref = parseGitRef(input.ref);
  const prBaseSha = parseOptionalFullGitSha(
    input.prBaseSha,
    "Git source PR base SHA",
  );
  const deployTagPrefix = parseDeployTagPrefix(input.deployTagPrefix);
  const authTokenEnv = parseAuthTokenEnv(input.authTokenEnv);
  const authUsername = parseAuthUsername(authTokenEnv, input.authUsername);
  const plan: GitSourcePlan = {
    commitSha,
    deployTagPrefix,
    mode,
    repositoryUrl,
  };

  if (authTokenEnv !== undefined) {
    plan.auth = { tokenEnv: authTokenEnv, username: authUsername! };
  }

  if (ref !== undefined) {
    plan.ref = ref;
  }

  if (prBaseSha !== undefined) {
    plan.prBaseSha = prBaseSha;
  }

  return plan;
}
