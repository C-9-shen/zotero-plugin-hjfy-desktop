import {
  addChineseSupport,
  applyLatexUnits,
  findMainFile,
  LatexMarkerError,
  type LatexUnit,
  planLatex,
  resolveTexInput,
  restoreLatex,
} from "./source";

export interface LatexProvider {
  translate(text: string, feedback?: string): Promise<string>;
  cacheKey: string;
}

export interface TranslationCache {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
}

/** Runtime-independent pipeline; filesystem, API, cache and compiler stay outside. */
export async function translateLatexProject(
  files: Map<string, string>,
  provider: LatexProvider,
  cache: TranslationCache,
  hash: (value: string) => Promise<string>,
  update: (text: string) => void,
  checkCancelled: () => void,
  configuredMain = "",
) {
  const main = findMainFile(files, configuredMain);
  const plans = new Map<string, ReturnType<typeof planLatex>>();
  const visited = new Map<string, boolean>();
  const visit = (name: string, body: boolean) => {
    if (visited.get(name) === true || visited.get(name) === body) return;
    visited.set(name, body);
    const plan = planLatex(files.get(name)!, name === main ? false : body);
    plans.set(name, plan);
    for (const input of plan.inputs)
      visit(resolveTexInput(name, input.path, files, main), input.body);
  };
  visit(main, false);
  const tasks = [...plans].flatMap(([file, plan]) =>
    plan.units.map((unit, index) => ({ file, index, unit })),
  );
  if (!tasks.length) throw new Error("未识别到可翻译的 LaTeX 正文。");
  const translated = new Map(
    [...plans].map(([file, plan]) => [file, Array<string>(plan.units.length)]),
  );
  let next = 0;
  let finished = 0;
  let cacheHits = 0;
  let failure: unknown;
  const translateUnit = async (
    unit: LatexUnit,
    onMarkerFailure?: () => void,
  ): Promise<{ value: string; cached: boolean }> => {
    checkCancelled();
    if (unit.text.length > 16000)
      throw new Error(
        `段落过长（${unit.text.length} 字符），请拆分源文件段落。`,
      );
    // Keep the existing cache key so upgrading does not repeat valid requests.
    const key = await hash(
      JSON.stringify([
        "hjfy-lite-v1",
        provider.cacheKey,
        unit.text,
        unit.protected,
      ]),
    );
    let value = await cache.read(key);
    if (value !== undefined) {
      try {
        restoreLatex(unit, value);
        return { value, cached: true };
      } catch {
        value = undefined;
      }
    }
    let lastError: unknown;
    let feedback = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      checkCancelled();
      try {
        value = await provider.translate(unit.text, feedback);
        restoreLatex(unit, value);
        lastError = undefined;
        break;
      } catch (error) {
        checkCancelled();
        lastError = error;
        feedback =
          error instanceof LatexMarkerError
            ? `The previous response changed protected tokens. Copy this exact token sequence once each, in order: ${unit.protected.map((_, i) => `[[HJFY_${i}]]`).join(" ")}. Translate only the text between tokens.`
            : "The previous response was invalid. Return a complete Simplified Chinese translation with every protected token intact and no added TeX or markdown.";
      }
    }
    if (lastError !== undefined) {
      if (!(lastError instanceof LatexMarkerError) || !onMarkerFailure)
        throw lastError;
      onMarkerFailure();
      // Own the structure locally when a model cannot reliably copy tokens.
      // Never guess where a missing formula belongs in a damaged response.
      const parts = unit.text.split(/(\[\[HJFY_\d+\]\])/);
      for (let i = 0; i < parts.length; i += 2) {
        const text = parts[i];
        if (!/[a-zA-Z]{2,}/.test(text)) continue;
        const part = { start: 0, end: text.length, text, protected: [] };
        // Scientific acronyms can stay unchanged, just as in whole segments.
        try {
          restoreLatex(part, text);
          continue;
        } catch {
          // This span contains prose and still needs translation.
        }
        const translated = (await translateUnit(part)).value;
        parts[i] =
          /^\s*/.exec(text)![0] + translated.trim() + /\s*$/.exec(text)![0];
      }
      value = parts.join("");
      restoreLatex(unit, value);
    }
    checkCancelled();
    await cache.write(key, value!);
    return { value: value!, cached: false };
  };
  const worker = async () => {
    while (next < tasks.length && !failure) {
      const { file, index, unit } = tasks[next++];
      try {
        const result = await translateUnit(unit, () =>
          update(
            `${file} 第 ${index + 1} 段：保护标记重试失败，正在分段翻译并保留原始公式…`,
          ),
        );
        if (result.cached) cacheHits++;
        translated.get(file)![index] = result.value;
        update(
          `正文翻译 ${++finished}/${tasks.length}（缓存 ${cacheHits}）：${file}`,
        );
      } catch (error) {
        failure = new Error(
          `${file} 第 ${index + 1} 段：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  await Promise.all([worker(), worker()]);
  if (failure) throw failure;
  checkCancelled();
  const output = new Map(files);
  for (const [file, plan] of plans)
    output.set(
      file,
      applyLatexUnits(files.get(file)!, plan.units, translated.get(file)!),
    );
  output.set(main, addChineseSupport(output.get(main)!));
  return { files: output, main, requested: tasks.length, cacheHits };
}
