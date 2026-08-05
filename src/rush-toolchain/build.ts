import {
  dag,
  type Container,
  type File,
  type Platform,
} from "@dagger.io/dagger";

import type { RushToolchainDownload } from "../model/rush-toolchain.ts";
import type { ToolchainImageSpec } from "../model/toolchain-image.ts";
import { CONFIGURED_RUSH_TOOLCHAIN_IMAGE_SPEC_VERSION } from "../toolchain-images/spec.ts";
import {
  RUSH_TOOLCHAIN_CONNECT_TIMEOUT_SECONDS,
  RUSH_TOOLCHAIN_MAX_DOWNLOAD_BYTES,
  RUSH_TOOLCHAIN_MAX_REDIRECTS,
  RUSH_TOOLCHAIN_TRANSFER_IMAGE,
  RUSH_TOOLCHAIN_TRANSFER_TIMEOUT_SECONDS,
} from "./constants.ts";

const DOWNLOAD_SCRIPT = `
set -eu
umask 077
mkdir -p /tmp/rush-delivery/extracted
curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' \
  --max-redirs "${RUSH_TOOLCHAIN_MAX_REDIRECTS}" \
  --connect-timeout "${RUSH_TOOLCHAIN_CONNECT_TIMEOUT_SECONDS}" \
  --max-time "${RUSH_TOOLCHAIN_TRANSFER_TIMEOUT_SECONDS}" \
  --max-filesize "${RUSH_TOOLCHAIN_MAX_DOWNLOAD_BYTES}" \
  --output /tmp/rush-delivery/download "$1"
actual_sha256="$(sha256sum /tmp/rush-delivery/download | cut -d ' ' -f 1)"
if [ "$actual_sha256" != "$2" ]; then
  printf '%s\n' 'rush-delivery toolchain download checksum mismatch' >&2
  exit 42
fi

case "$3" in
  raw)
    selected=/tmp/rush-delivery/download
    ;;
  tar_gz)
    member="$4"
    member_count="$(tar -tzf /tmp/rush-delivery/download | awk -v expected="$member" '$0 == expected { count += 1 } END { print count + 0 }')"
    if [ "$member_count" != 1 ]; then
      printf '%s\n' 'rush-delivery toolchain archive member must exist exactly once' >&2
      exit 43
    fi
    member_listing="$(tar -tvzf /tmp/rush-delivery/download "$member")"
    case "$member_listing" in
      -*) ;;
      *)
        printf '%s\n' 'rush-delivery toolchain archive member must be a regular file' >&2
        exit 44
        ;;
    esac
    member_bytes="$(printf '%s\n' "$member_listing" | awk 'NR == 1 { print $3 }')"
    case "$member_bytes" in
      ''|*[!0-9]*)
        printf '%s\n' 'rush-delivery toolchain archive member size was invalid' >&2
        exit 45
        ;;
    esac
    if [ "$member_bytes" -gt "${RUSH_TOOLCHAIN_MAX_DOWNLOAD_BYTES}" ]; then
      printf '%s\n' 'rush-delivery toolchain archive member exceeds the byte limit' >&2
      exit 46
    fi
    tar -xzf /tmp/rush-delivery/download -C /tmp/rush-delivery/extracted "$member"
    selected="/tmp/rush-delivery/extracted/$member"
    if [ ! -f "$selected" ] || [ -L "$selected" ]; then
      printf '%s\n' 'rush-delivery toolchain archive member extraction was unsafe' >&2
      exit 47
    fi
    ;;
  *)
    printf '%s\n' 'rush-delivery toolchain download format was invalid' >&2
    exit 48
    ;;
esac

selected_bytes="$(wc -c < "$selected")"
if [ "$selected_bytes" -gt "${RUSH_TOOLCHAIN_MAX_DOWNLOAD_BYTES}" ]; then
  printf '%s\n' 'rush-delivery toolchain selected file exceeds the byte limit' >&2
  exit 49
fi
cp "$selected" /tmp/rush-delivery/output
chmod 0755 /tmp/rush-delivery/output
`;

function materializeDownload(download: RushToolchainDownload): File {
  return dag
    .container({ platform: "linux/amd64" as Platform })
    .from(RUSH_TOOLCHAIN_TRANSFER_IMAGE)
    .withExec(
      [
        "sh",
        "-ceu",
        DOWNLOAD_SCRIPT,
        "rush-delivery-download",
        download.url,
        download.sha256,
        download.format,
        download.archive_path ?? "",
      ],
      { expand: false },
    )
    .file("/tmp/rush-delivery/output");
}

async function preflightConfiguredBase(container: Container): Promise<Container> {
  return container
    .withExec(
      [
        "bash",
        "-ceu",
        [
          "command -v bash >/dev/null",
          "command -v node >/dev/null",
          "command -v apt-get >/dev/null",
          'node --version | grep -Eq "^v24\\."',
        ].join("\n"),
      ],
      { expand: false },
    )
    .sync();
}

export async function buildConfiguredRushToolchainContainer(
  spec: ToolchainImageSpec,
): Promise<Container> {
  if (
    spec.version !== CONFIGURED_RUSH_TOOLCHAIN_IMAGE_SPEC_VERSION ||
    spec.platform !== "linux/amd64" ||
    spec.downloads === undefined
  ) {
    throw new Error("Configured Rush toolchain image spec is incomplete.");
  }

  let container = await preflightConfiguredBase(
    dag.container({ platform: spec.platform as Platform }).from(spec.baseImage),
  );

  if (spec.install.length > 0) {
    container = container.withExec(["bash", "-lc", spec.install.join(" && ")], {
      expand: false,
    });
  }

  for (const download of spec.downloads) {
    container = container.withFile(
      download.destination,
      materializeDownload(download),
      { permissions: 0o755 },
    );
  }

  return container;
}
