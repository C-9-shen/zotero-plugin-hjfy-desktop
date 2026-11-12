import { unzipSync } from "fflate";
import { getPref } from "../../utils/prefs";

// Pinned official Windows x64 release. Downloaded on demand, never bundled in XPI.
const VERSION = "0.17.0";
const ARCHIVE_SHA256 =
  "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f";
export const TECTONIC_URL = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/tectonic-${VERSION}-x86_64-pc-windows-msvc.zip`;

export async function ensurePortableTex(
  update: (text: string) => void,
): Promise<string> {
  const configured = String(getPref("lightweight.tectonicPath") || "").trim();
  if (configured) {
    if (
      !PathUtils.isAbsolute(configured) ||
      !(await IOUtils.exists(configured))
    )
      throw new Error("便携 TeX 程序路径无效，请选择 tectonic.exe。");
    return configured;
  }
  if (!Zotero.isWin || !Services.appinfo.XPCOMABI.startsWith("x86_64"))
    throw new Error(
      "自动下载便携 TeX 目前仅支持 Windows x64，请手动指定 Tectonic 路径。",
    );
  const directory = PathUtils.join(
    PathUtils.profileDir,
    "hjfy-lightweight",
    "runtime",
    `tectonic-${VERSION}`,
  );
  const binary = PathUtils.join(directory, "tectonic.exe");
  const receipt = PathUtils.join(directory, "verified.json");
  if ((await IOUtils.exists(binary)) && (await IOUtils.exists(receipt))) {
    const previous = (await IOUtils.readJSON(receipt)) as {
      archive: string;
      executable: string;
    };
    if (
      previous.archive === ARCHIVE_SHA256 &&
      previous.executable === (await IOUtils.computeHexDigest(binary, "sha256"))
    )
      return binary;
  }
  await IOUtils.makeDirectory(directory, { createAncestors: true });
  const archive = PathUtils.join(directory, "download.zip");
  update(`首次下载便携 TeX ${VERSION}…`);
  try {
    await Zotero.File.download(TECTONIC_URL, archive);
    if ((await IOUtils.computeHexDigest(archive, "sha256")) !== ARCHIVE_SHA256)
      throw new Error("便携 TeX 下载校验失败，未运行该文件。");
    const files = unzipSync(await IOUtils.read(archive), {
      filter: (entry) =>
        entry.name === "tectonic.exe" && entry.originalSize < 100 * 1024 * 1024,
    });
    if (!files["tectonic.exe"])
      throw new Error("便携 TeX 下载包不包含预期程序。");
    await IOUtils.write(binary, files["tectonic.exe"]);
    await IOUtils.writeJSON(receipt, {
      archive: ARCHIVE_SHA256,
      executable: await IOUtils.computeHexDigest(binary, "sha256"),
    });
    return binary;
  } catch (error) {
    throw new Error(
      `便携 TeX 准备失败，可手动下载后在设置中指定程序路径。${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await IOUtils.remove(archive, { ignoreAbsent: true });
  }
}
