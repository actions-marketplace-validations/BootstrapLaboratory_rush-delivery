export type RushToolchainDownloadFormat = "raw" | "tar_gz";

export type RushToolchainDownload = {
  archive_path?: string;
  destination: string;
  format: RushToolchainDownloadFormat;
  mode: "0755";
  sha256: string;
  url: string;
};

export type RushToolchainDefinition = {
  base_image: string;
  downloads: RushToolchainDownload[];
  platform: "linux/amd64";
  version: "rush-delivery-rush-toolchain/v1";
};
