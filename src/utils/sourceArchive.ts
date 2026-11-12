import { Gunzip, strFromU8 } from "fflate";

const MAX_SOURCE_SIZE = 500 * 1024 * 1024;

export interface SourceEntry {
  path: string;
  data: Uint8Array;
}

function safePath(path: string): string {
  if (
    /[\\:]/.test(path) ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32) ||
    path.startsWith("/") ||
    path
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          (/[. ]$/.test(part) && part !== ".") ||
          /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part),
      )
  ) {
    throw new Error("arXiv 源码包含不安全的文件路径。");
  }
  return path
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

function field(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return strFromU8(end < 0 ? bytes : bytes.subarray(0, end));
}

function number(bytes: Uint8Array): number {
  const value = field(bytes).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error("不支持的 tar 数字格式。");
  return value ? parseInt(value, 8) : 0;
}

function paxFields(bytes: Uint8Array): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const length = Number(strFromU8(bytes.subarray(offset, space)));
    if (
      space < offset ||
      !Number.isSafeInteger(length) ||
      length <= space - offset + 1 ||
      offset + length > bytes.length
    ) {
      throw new Error("无效的 tar 扩展头。");
    }
    const record = strFromU8(bytes.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals < 1 || bytes[offset + length - 1] !== 10)
      throw new Error("无效的 tar 扩展字段。");
    result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

/** Decode gzip/tar or a single TeX source, without invoking an external utility. */
export function readSourceArchive(download: Uint8Array): SourceEntry[] {
  if (download.length > 200 * 1024 * 1024)
    throw new Error("arXiv 源码超过 200 MiB。");
  let bytes = download;
  if (bytes[0] === 31 && bytes[1] === 139) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const gzip = new Gunzip((chunk) => {
      size += chunk.length;
      if (size > MAX_SOURCE_SIZE) throw new Error("解压后的源码超过 500 MiB。");
      chunks.push(chunk);
    });
    // Bound each inflate operation as well as the final archive size.
    for (let offset = 0; offset < download.length; offset += 65536) {
      gzip.push(
        download.subarray(offset, offset + 65536),
        offset + 65536 >= download.length,
      );
    }
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }
  if (bytes.length < 265 || field(bytes.subarray(257, 262)) !== "ustar") {
    if (!/\\(documentclass|documentstyle)\b/.test(strFromU8(bytes))) {
      throw new Error("arXiv 未返回可用的 LaTeX 源码。");
    }
    return [{ path: "main.tex", data: bytes }];
  }
  const entries: SourceEntry[] = [];
  const paths = new Set<string>();
  let pending: Record<string, string> = {};
  let global: Record<string, string> = {};
  let count = 0;
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (++count > 10000) throw new Error("源码归档条目过多。");
    const checksum = header.reduce(
      (sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte),
      0,
    );
    if (checksum !== number(header.subarray(148, 156)))
      throw new Error("tar 文件校验失败。");
    const size = number(header.subarray(124, 136));
    const start = offset + 512;
    if (start + size > bytes.length) throw new Error("源码归档不完整。");
    const data = bytes.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] || 48);
    if (type === "x" || type === "g") {
      const values = paxFields(data);
      if (Object.keys(values).some((key) => /sparse|linkpath|size/i.test(key)))
        throw new Error("不支持的 tar 扩展类型。");
      if (type === "g") global = { ...global, ...values };
      else pending = { ...pending, ...values };
      continue;
    }
    if (type === "L") {
      pending.path = field(data).replace(/\n$/, "");
      continue;
    }
    if (type !== "0" && type !== "5")
      throw new Error("源码归档包含链接或不支持的条目。");
    const prefix = field(header.subarray(345, 500));
    const name = field(header.subarray(0, 100));
    const path = safePath(
      pending.path || global.path || (prefix ? `${prefix}/${name}` : name),
    );
    pending = {};
    if (!path || type === "5") continue;
    const key = path.toLowerCase();
    if (paths.has(key)) throw new Error("源码归档包含重复文件路径。");
    paths.add(key);
    entries.push({ path, data });
  }
  if (!entries.some(({ path }) => /\.tex$/i.test(path)))
    throw new Error("源码归档没有 .tex 文件。");
  return entries;
}
