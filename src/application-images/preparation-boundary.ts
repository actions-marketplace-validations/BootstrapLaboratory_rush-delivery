export type ApplicationImagePreparationCoordinates = {
  gitSha: string;
  sourceRepositoryUrl?: string;
};

export function isolateApplicationImagePreparationCoordinates(
  options: ApplicationImagePreparationCoordinates & Record<string, unknown>,
): ApplicationImagePreparationCoordinates {
  return {
    gitSha: options.gitSha,
    ...(options.sourceRepositoryUrl === undefined
      ? {}
      : { sourceRepositoryUrl: options.sourceRepositoryUrl }),
  };
}
