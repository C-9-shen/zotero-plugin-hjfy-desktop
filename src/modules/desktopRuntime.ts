import { strFromU8 } from "fflate";
import { getPref } from "../utils/prefs";
import { readSourceArchive } from "../utils/sourceArchive";

const PACKAGE_NAME = "A65FC766.2255F2ECFA78";
const PACKAGE_FAMILY = `${PACKAGE_NAME}_swakhz099rbkj`;

export function findDesktopInstallation(): string {
  const configured = String(
    getPref("desktop.installationDirectory") || "",
  ).trim();
  if (configured) return configured;
  const registry = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
    Ci.nsIWindowsRegKey,
  );
  try {
    registry.open(
      Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER!,
      "Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages",
      Ci.nsIWindowsRegKey.ACCESS_READ!,
    );
    const matches = Array.from({ length: registry.childCount }, (_, i) =>
      registry.getChildName(i),
    )
      .filter((name) => name.startsWith(`${PACKAGE_NAME}_`))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of matches) {
      const child = registry.openChild(name, Ci.nsIWindowsRegKey.ACCESS_READ!);
      try {
        return child.readStringValue("PackageRootFolder");
      } finally {
        child.close();
      }
    }
  } catch {
    // A portable installation can always be selected explicitly in preferences.
  } finally {
    registry.close();
  }
  throw new Error("未找到幻觉翻译桌面端，请在插件设置中指定安装目录。");
}

/** Windows DPAPI, called in-process through Mozilla js-ctypes; no shell or helper. */
export function decryptDesktopKey(encrypted: Uint8Array): string {
  const { ctypes } = ChromeUtils.importESModule(
    "resource://gre/modules/ctypes.sys.mjs",
  ) as any;
  const crypt = ctypes.open("Crypt32.dll");
  const kernel = ctypes.open("Kernel32.dll");
  const Blob = ctypes.StructType("HjfyDataBlob", [
    { cbData: ctypes.uint32_t },
    { pbData: ctypes.uint8_t.ptr },
  ]);
  const inputBytes = ctypes.uint8_t.array(encrypted.length)(
    Array.from(encrypted),
  );
  const input = Blob(encrypted.length, inputBytes.addressOfElement(0));
  const output = Blob();
  const unprotect = crypt.declare(
    "CryptUnprotectData",
    ctypes.winapi_abi,
    ctypes.int32_t,
    Blob.ptr,
    ctypes.voidptr_t,
    ctypes.voidptr_t,
    ctypes.voidptr_t,
    ctypes.voidptr_t,
    ctypes.uint32_t,
    Blob.ptr,
  );
  const free = kernel.declare(
    "LocalFree",
    ctypes.winapi_abi,
    ctypes.voidptr_t,
    ctypes.voidptr_t,
  );
  try {
    if (
      !unprotect(input.address(), null, null, null, null, 1, output.address())
    ) {
      throw new Error(
        "无法解密桌面端模型凭据，请使用同一 Windows 用户重新保存桌面端模型配置。",
      );
    }
    const view = ctypes.cast(
      output.pbData,
      ctypes.uint8_t.array(output.cbData).ptr,
    ).contents;
    const plain = new Uint8Array(output.cbData);
    try {
      for (let i = 0; i < plain.length; i++) plain[i] = view[i];
      return strFromU8(plain);
    } finally {
      plain.fill(0);
      for (let i = 0; i < output.cbData; i++) view[i] = 0;
    }
  } finally {
    if (!output.pbData.isNull()) free(output.pbData);
    for (let i = 0; i < encrypted.length; i++) inputBytes[i] = 0;
    kernel.close();
    crypt.close();
  }
}

export async function prepareDesktopTask(
  arxivId: string,
  job: string,
  runtime: string,
  update: (text: string) => void,
) {
  const installation = findDesktopInstallation();
  const bundled = PathUtils.join(
    installation,
    "Engines",
    "Office",
    "hjfy-office.exe",
  );
  if (!(await IOUtils.exists(bundled)))
    throw new Error("安装目录中没有 Engines/Office/hjfy-office.exe。");
  const hash = await IOUtils.computeHexDigest(bundled, "sha256");
  const engineDir = PathUtils.join(runtime, hash);
  await IOUtils.makeDirectory(engineDir, { createAncestors: true });
  const engine = PathUtils.join(engineDir, "hjfy-office.exe");
  if (!(await IOUtils.exists(engine))) await IOUtils.copy(bundled, engine);

  const data =
    String(getPref("desktop.dataDirectory") || "").trim() ||
    PathUtils.join(
      Services.env.get("LOCALAPPDATA"),
      "Packages",
      PACKAGE_FAMILY,
      "LocalCache",
      "Local",
      "HJFY-Win-Lab",
    );
  const profiles = await IOUtils.readJSON(PathUtils.join(data, "models.json"));
  const name = String(getPref("desktop.modelName") || "").trim();
  const profile = (Array.isArray(profiles) ? profiles : [profiles]).find(
    (p) => p.Enabled && (!name || p.Name === name),
  );
  if (!profile)
    throw new Error(
      "未找到已启用的模型，请在桌面端配置模型并检查插件中的模型名称。",
    );
  const connection = profile.Connection;
  if (
    !connection ||
    !["chat-completions", "responses"].includes(connection.Protocol)
  )
    throw new Error("此模型协议不受 LaTeX 引擎支持。");
  let key = "local-no-key";
  if (connection.RequiresKey) {
    if (
      typeof profile.CredentialId !== "string" ||
      !/^[\w-]+$/.test(profile.CredentialId)
    )
      throw new Error("无效的桌面端凭据标识。");
    key = decryptDesktopKey(
      await IOUtils.read(PathUtils.join(data, `${profile.CredentialId}.key`)),
    );
  }
  update("正在下载 arXiv 源码…");
  const archive = PathUtils.join(job, "source.download");
  await Zotero.File.download(`https://arxiv.org/src/${arxivId}`, archive);
  if (((await IOUtils.stat(archive)).size || 0) > 200 * 1024 * 1024)
    throw new Error("arXiv 源码超过 200 MiB。");
  update("正在解压 LaTeX 源码…");
  const entries = readSourceArchive(await IOUtils.read(archive));
  const source = PathUtils.join(job, "source");
  await IOUtils.makeDirectory(source);
  for (const entry of entries) {
    const target = PathUtils.join(source, ...entry.path.split("/"));
    await IOUtils.makeDirectory(PathUtils.parent(target)!, {
      createAncestors: true,
    });
    await IOUtils.write(target, entry.data);
  }
  update(`正在使用 ${profile.Name} 翻译…`);
  return {
    command: engine,
    arguments: [
      "--latex-project",
      source,
      "--latex-project-output-dir",
      PathUtils.join(job, "translated"),
      "--target-language",
      "zh-Hans",
      "--events=jsonl",
      "--ui-language=zh-Hans",
      "--translation-cache-db",
      PathUtils.join(runtime, "translations.sqlite3"),
      "--provider",
      connection.Protocol,
      "--base-url",
      connection.BaseUrl,
      "--model",
      connection.Model,
      "--api-key-env",
      "HJFY_PLUGIN_API_KEY",
      "--concurrency",
      "2",
    ],
    environment: { HJFY_PLUGIN_API_KEY: key },
    environmentAppend: true,
    workdir: job,
    stderr: "pipe",
  };
}
