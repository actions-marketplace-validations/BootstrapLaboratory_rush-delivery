export const RELEASE_GIT_ASKPASS_PATH = "/tmp/rush-delivery-git-askpass.sh";

export function releaseGitAskpassScript(
  usernameEnv: string,
  tokenEnv: string,
): string {
  for (const [name, value] of [
    ["username", usernameEnv],
    ["token", tokenEnv],
  ] as const) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(value)) {
      throw new Error(`Release Git ${name} env name is invalid.`);
    }
  }

  return [
    "#!/bin/sh",
    'case "$1" in',
    `  *Username*) printf '%s\\n' "\${${usernameEnv}}" ;;`,
    `  *Password*) printf '%s\\n' "\${${tokenEnv}}" ;;`,
    "  *) exit 1 ;;",
    "esac",
    "",
  ].join("\n");
}
