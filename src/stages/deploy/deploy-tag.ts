export function deployTagPrefixForEnvironment(environment: string): string {
  return `deploy/${environment}`;
}

export function deployTagName(environment: string, target: string): string {
  return `${deployTagPrefixForEnvironment(environment)}/${target}`;
}

type GithubRefUpdateInput = {
  apiUrl?: string;
  gitSha: string;
  repository: string;
  tagName: string;
};

type GithubRefRequest = {
  body: string;
  method: "PATCH" | "POST";
  url: string;
};

const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function requireNonEmpty(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }

  return value;
}

function parseGithubRepository(value: string): string {
  const repository = requireNonEmpty(value, "GitHub repository");

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(
      `GitHub repository must use owner/repo form, got "${repository}".`,
    );
  }

  return repository;
}

function parseGithubApiUrl(value: string | undefined): string {
  const rawApiUrl =
    value === undefined || value.length === 0
      ? "https://api.github.com"
      : value;

  if (/\s|[\u0000-\u001f\u007f]/u.test(rawApiUrl)) {
    throw new Error("GitHub API URL must be a credential-free HTTPS URL.");
  }

  let apiUrl: URL;

  try {
    apiUrl = new URL(rawApiUrl);
  } catch {
    throw new Error("GitHub API URL must be a credential-free HTTPS URL.");
  }

  if (
    apiUrl.protocol !== "https:" ||
    apiUrl.username.length > 0 ||
    apiUrl.password.length > 0 ||
    apiUrl.search.length > 0 ||
    apiUrl.hash.length > 0
  ) {
    throw new Error("GitHub API URL must be a credential-free HTTPS URL.");
  }

  return `${apiUrl.origin}${apiUrl.pathname}`.replace(/\/+$/u, "");
}

function parseGitSha(value: string): string {
  const gitSha = requireNonEmpty(value, "Git SHA");

  if (!FULL_GIT_SHA_PATTERN.test(gitSha)) {
    throw new Error("Git SHA must be a full 40-character SHA.");
  }

  return gitSha.toLowerCase();
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

export function buildGithubDeployTagUpdateRequests(
  input: GithubRefUpdateInput,
): {
  create: GithubRefRequest;
  update: GithubRefRequest;
} {
  const apiUrl = parseGithubApiUrl(input.apiUrl);
  const repository = parseGithubRepository(input.repository);
  const gitSha = parseGitSha(input.gitSha);
  const tagName = requireNonEmpty(input.tagName, "Deploy tag name");
  const ref = `refs/tags/${tagName}`;
  const refPath = `tags/${tagName}`;

  return {
    create: {
      body: JSON.stringify({
        ref,
        sha: gitSha,
      }),
      method: "POST",
      url: `${apiUrl}/repos/${encodePath(repository)}/git/refs`,
    },
    update: {
      body: JSON.stringify({
        force: true,
        sha: gitSha,
      }),
      method: "PATCH",
      url: `${apiUrl}/repos/${encodePath(repository)}/git/refs/${encodePath(refPath)}`,
    },
  };
}

export function buildDeployTargetCommand(deployScript: string): string {
  return `bash ${deployScript}`;
}

async function assertGithubResponseOk(
  response: Response,
  action: string,
): Promise<void> {
  if (response.ok) {
    return;
  }

  throw new Error(
    `Failed to ${action}: GitHub API returned ${response.status}.`,
  );
}

export async function updateDeployTagWithGithubApi(
  environment: string,
  target: string,
  gitSha: string,
  hostEnv: Record<string, string>,
  tokenEnv: string,
): Promise<string> {
  const tagName = deployTagName(environment, target);

  if (tokenEnv.length === 0) {
    throw new Error("Deploy tag update requires a GitHub token env name.");
  }

  const token = requireNonEmpty(hostEnv[tokenEnv], `Host env ${tokenEnv}`);
  const requests = buildGithubDeployTagUpdateRequests({
    apiUrl: hostEnv.GITHUB_API_URL,
    gitSha,
    repository: hostEnv.GITHUB_REPOSITORY ?? "",
    tagName,
  });
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  console.log(`[deploy-release] update deploy tag ${tagName} -> ${gitSha}`);

  const updateResponse = await fetch(requests.update.url, {
    body: requests.update.body,
    headers,
    method: requests.update.method,
  });

  if (updateResponse.status !== 404) {
    await assertGithubResponseOk(updateResponse, `update ${tagName}`);
    return `[deploy-release] updated deploy tag ${tagName}\n`;
  }

  const createResponse = await fetch(requests.create.url, {
    body: requests.create.body,
    headers,
    method: requests.create.method,
  });
  await assertGithubResponseOk(createResponse, `create ${tagName}`);

  return `[deploy-release] created deploy tag ${tagName}\n`;
}

export async function updateDeployTagWithGithubApiIfConfigured(
  environment: string,
  target: string,
  gitSha: string,
  hostEnv: Record<string, string>,
  tokenEnv: string,
): Promise<string> {
  if (tokenEnv.length === 0) {
    return "";
  }

  return updateDeployTagWithGithubApi(
    environment,
    target,
    gitSha,
    hostEnv,
    tokenEnv,
  );
}
