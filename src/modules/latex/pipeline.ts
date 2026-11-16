import {
  addChineseSupport,
  applyLatexUnits,
  findMainFile,
  normalizeLatexMarkers,
  type LatexUnit,
  planLatex,
  resolveTexInput,
  restoreLatex,
} from "./source";

export interface LatexProvider {
  translate(text: string, feedback?: string): Promise<string>;
  cacheKey: string;
  diagnostic?(record: BatchDiagnostic): Promise<void>;
}

interface SegmentIssue {
  id: number;
  error: string;
  expected: string[];
  actual: string[] | null;
  missing: string[];
  duplicates: string[];
  unexpected: string[];
}

export interface BatchDiagnostic {
  file: string;
  batch: number;
  attempt: number;
  request: string;
  response: string;
  error?: string;
  issues: SegmentIssue[];
}

export interface TranslationCache {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
}

interface PendingUnit {
  file: string;
  index: number;
  unit: LatexUnit;
  key: string;
}

/** IDs identify source paragraphs; syntax tokens stay local to each paragraph. */
function batchRequest(tasks: PendingUnit[]) {
  return JSON.stringify({
    segments: tasks.map(({ index, unit }) => ({
      id: index + 1,
      text: unit.text,
    })),
  });
}

function batchResponse(response: string, tasks: PendingUnit[]) {
  // Accept an exact JSON fence, but never guess where partial JSON starts/ends.
  const text = response.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  let result;
  try {
    result = JSON.parse(fenced ? fenced[1] : text);
  } catch {
    throw new Error("模型未返回有效的批量 JSON。");
  }
  if (!result || !Array.isArray(result.segments))
    throw new Error("模型批量 JSON 缺少 segments 数组。");
  const expected = new Set(tasks.map((task) => task.index + 1));
  const values = new Map<number, unknown>();
  for (const segment of result.segments) {
    if (!segment || !expected.has(segment.id) || values.has(segment.id))
      throw new Error("模型批量 JSON 含未知、重复或无效的段落 ID。");
    values.set(segment.id, segment.text);
  }
  return values;
}

function segmentIssue(
  task: PendingUnit,
  value: unknown,
  error: string,
): SegmentIssue {
  const expected = task.unit.protected.map((_, i) => `[[HJFY_${i}]]`);
  const actual: string[] | null =
    typeof value === "string"
      ? normalizeLatexMarkers(value).match(/\[\[HJFY_\d+\]\]/g) || []
      : null;
  const tokens = actual || [];
  return {
    id: task.index + 1,
    error,
    expected,
    actual,
    missing: expected.filter((token) => !tokens.includes(token)),
    duplicates: [
      ...new Set(tokens.filter((token, i) => tokens.indexOf(token) !== i)),
    ],
    unexpected: [
      ...new Set(tokens.filter((token) => !expected.includes(token))),
    ],
  };
}

function issueMessage(issue: SegmentIssue) {
  const details = [
    issue.missing.length ? `缺失 ${issue.missing.slice(0, 4).join(" ")}` : "",
    issue.unexpected.length
      ? `未知 ${issue.unexpected.slice(0, 4).join(" ")}`
      : "",
  ].filter(Boolean);
  return `第 ${issue.id} 段：${issue.error}${details.length ? `（${details.join("；")}）` : ""}`;
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
  let finished = 0;
  let cacheHits = 0;
  let requests = 0;
  const pending: PendingUnit[] = [];
  for (const task of tasks) {
    checkCancelled();
    // Keep per-segment keys so upgrades and different batches reuse old cache.
    const key = await hash(
      JSON.stringify([
        "hjfy-lite-v1",
        provider.cacheKey,
        task.unit.text,
        task.unit.protected,
      ]),
    );
    const value = await cache.read(key);
    if (value !== undefined) {
      try {
        restoreLatex(task.unit, value);
        translated.get(task.file)![task.index] = value;
        cacheHits++;
        finished++;
        continue;
      } catch {
        // Invalid syntax/markers must be translated again.
      }
    }
    if (task.unit.text.length > 16000)
      throw new Error(
        `${task.file} 第 ${task.index + 1} 段过长（${task.unit.text.length} 字符），请拆分源文件段落。`,
      );
    pending.push({ ...task, key });
  }

  const batches: PendingUnit[][] = [];
  for (const task of pending) {
    const previous = batches.at(-1);
    if (
      !previous ||
      previous[0].file !== task.file ||
      previous.length >= 32 ||
      batchRequest([...previous, task]).length > 12000 ||
      previous.reduce((count, item) => count + item.unit.protected.length, 0) +
        task.unit.protected.length >
        48
    ) {
      batches.push([task]);
    } else {
      previous.push(task);
    }
  }
  update(
    `正文翻译 ${finished}/${tasks.length}（缓存 ${cacheHits}）；待翻译 ${pending.length} 段，合并为 ${batches.length} 个批次。`,
  );
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (next < batches.length && !failure) {
      const batchIndex = next++;
      const batch = batches[batchIndex];
      const first = batch[0];
      const range = `${first.file} 第 ${first.index + 1}–${batch.at(-1)!.index + 1} 段`;
      try {
        let remaining = batch;
        let feedback = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          checkCancelled();
          update(
            `批量翻译 ${batchIndex + 1}/${batches.length}（${remaining.length} 段）：${range}${attempt ? "，重试未通过段落" : ""}`,
          );
          const request = batchRequest(remaining);
          let response: string | undefined;
          const issues: SegmentIssue[] = [];
          let envelopeError: string | undefined;
          try {
            requests++;
            response = await provider.translate(request, feedback);
            checkCancelled();
            let values;
            try {
              values = batchResponse(response, remaining);
            } catch (error) {
              envelopeError =
                error instanceof Error ? error.message : String(error);
              throw error;
            }
            const retry: PendingUnit[] = [];
            for (const task of remaining) {
              checkCancelled();
              const value = values.get(task.index + 1);
              let valid: string;
              try {
                if (typeof value !== "string")
                  throw new Error("模型未返回该段落的文本。");
                valid = normalizeLatexMarkers(value);
                restoreLatex(task.unit, valid);
              } catch (error) {
                issues.push(
                  segmentIssue(
                    task,
                    value,
                    error instanceof Error ? error.message : String(error),
                  ),
                );
                retry.push(task);
                continue;
              }
              checkCancelled();
              await cache.write(task.key, valid);
              translated.get(task.file)![task.index] = valid;
              finished++;
            }
            remaining = retry;
            if (!remaining.length) break;
            throw new Error(issues.slice(0, 3).map(issueMessage).join("；"));
          } catch (error) {
            checkCancelled();
            if (response !== undefined && provider.diagnostic) {
              await provider
                .diagnostic({
                  file: first.file,
                  batch: batchIndex + 1,
                  attempt: attempt + 1,
                  request,
                  response,
                  error: envelopeError,
                  issues: issues.length
                    ? issues
                    : remaining.map((task) =>
                        segmentIssue(
                          task,
                          undefined,
                          envelopeError || "批次处理失败",
                        ),
                      ),
                })
                .catch(() => {});
              checkCancelled();
            }
            if (attempt === 1) throw error;
            feedback = `The previous response failed validation. Return valid JSON with only the requested segment IDs and nonempty text, no added TeX or explanations. Include every required token at least once and no unknown tokens. Tokens are restored by identity, not occurrence order. Preserve formatting and brace scopes when moving prose. Requirements: ${JSON.stringify(
              remaining.map((task) => ({
                id: task.index + 1,
                error:
                  issues.find((issue) => issue.id === task.index + 1)?.error ||
                  envelopeError ||
                  "Invalid response",
                tokens: task.unit.protected.map((_, i) => `[[HJFY_${i}]]`),
              })),
            )}`;
          }
        }
        update(
          `正文翻译 ${finished}/${tasks.length}（缓存 ${cacheHits}），批次 ${batchIndex + 1}/${batches.length} 完成：${range}`,
        );
      } catch (error) {
        failure ||= new Error(
          `${range}：${error instanceof Error ? error.message : String(error)}`,
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
  return { files: output, main, requested: tasks.length, cacheHits, requests };
}
