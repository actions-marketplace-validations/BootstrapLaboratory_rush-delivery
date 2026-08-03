import { Directory, ExistsType, FileType } from "@dagger.io/dagger";

import {
  type MetadataContractRepository,
  type MetadataContractValidationOptions,
  type MetadataContractValidationResult,
  validateMetadataContractRepository,
} from "./metadata-contract.ts";

class DaggerMetadataContractRepository implements MetadataContractRepository {
  private readonly repo: Directory;

  constructor(repo: Directory) {
    this.repo = repo;
  }

  async entries(path: string): Promise<string[]> {
    return this.repo.directory(path).entries();
  }

  async exists(
    path: string,
    expectedType: "directory" | "file",
  ): Promise<boolean> {
    return this.repo.exists(path, {
      expectedType:
        expectedType === "file"
          ? ExistsType.RegularType
          : ExistsType.DirectoryType,
    });
  }

  async isSymlink(path: string): Promise<boolean> {
    try {
      return (
        (await this.repo
          .stat(path, { doNotFollowSymlinks: true })
          .fileType()) === FileType.Symlink
      );
    } catch {
      return false;
    }
  }

  async readTextFile(path: string): Promise<string> {
    return this.repo.file(path).contents();
  }
}

export async function validateMetadataContract(
  repo: Directory,
  options: MetadataContractValidationOptions = {},
): Promise<MetadataContractValidationResult> {
  return validateMetadataContractRepository(
    new DaggerMetadataContractRepository(repo),
    options,
  );
}

export async function assertMetadataContract(
  repo: Directory,
  options: MetadataContractValidationOptions = {},
): Promise<void> {
  await validateMetadataContract(repo, options);
}
