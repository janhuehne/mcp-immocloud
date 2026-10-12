import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ImmocloudClient } from "../immocloud/client.js";
import { encodeImmocloudId } from "../immocloud/ids.js";

export const OPERATING_COST_EXPORT_FORMATS = [
  "pdf",
  "docx",
  "xlsx",
  "zip",
] as const;

export type OperatingCostExportFormat =
  (typeof OPERATING_COST_EXPORT_FORMATS)[number];

export type OperatingCostTenancyTarget = {
  tenancyId: string;
  tenantName: string;
  unitId: string | null;
  unitName: string | null;
};

const MIME_BY_FORMAT: Record<OperatingCostExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

/** Safe filename segment (no path separators). */
export function slugFilenamePart(value: string, maxLen = 80): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\/\\]+/g, "-")
    .replace(/\s+/g, "_")
    .replace(/[^\w.\-äöüÄÖÜß]+/g, "")
    .replace(/_+/g, "_")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return (cleaned || "file").slice(0, maxLen);
}

/**
 * Resolve a download directory under `{cwd}/downloads/…`.
 * `subdir` may be relative (e.g. `rs810-bka-2025`) but cannot escape `downloads/`.
 */
export function resolveDownloadsDir(subdir?: string): string {
  const root = path.resolve(process.cwd(), "downloads");
  const target = path.resolve(root, subdir?.trim() || "immocloud-bka");
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      'outputDir must stay under the project "./downloads" directory.',
    );
  }
  return target;
}

export function listTenancyTargetsFromStatement(
  statement: unknown,
): OperatingCostTenancyTarget[] {
  if (typeof statement !== "object" || statement === null) {
    return [];
  }
  const unitResultList = (statement as Record<string, unknown>).unitResultList;
  if (!Array.isArray(unitResultList)) {
    return [];
  }

  const propertyId = (statement as Record<string, unknown>).propertyId;
  const out: OperatingCostTenancyTarget[] = [];
  const seen = new Set<string>();

  for (const unit of unitResultList) {
    if (typeof unit !== "object" || unit === null) continue;
    const row = unit as Record<string, unknown>;
    const unitId = typeof row.unitId === "string" ? row.unitId : null;
    if (unitId && propertyId && unitId === propertyId) {
      continue; // "Andere Einheiten" aggregate row
    }
    const unitName = typeof row.unitName === "string" ? row.unitName : null;
    const tenants = Array.isArray(row.tenants) ? row.tenants : [];
    for (const tenant of tenants) {
      if (typeof tenant !== "object" || tenant === null) continue;
      const t = tenant as Record<string, unknown>;
      const tenancyId = typeof t.tenancyId === "string" ? t.tenancyId : null;
      if (!tenancyId || seen.has(tenancyId)) continue;
      seen.add(tenancyId);
      const tenantName =
        (typeof t.tenantName === "string" && t.tenantName.trim()) ||
        (typeof t.name === "string" && t.name.trim()) ||
        (typeof t.fullName === "string" && t.fullName.trim()) ||
        "Mieter";
      out.push({ tenancyId, tenantName, unitId, unitName });
    }
  }
  return out;
}

function exportApiPath(
  statementId: string,
  format: OperatingCostExportFormat,
  tenancyId: string | "all",
): string {
  const sid = encodeImmocloudId(statementId, "Statement ID");
  if (tenancyId === "all") {
    if (format !== "pdf") {
      throw new Error(
        'mode "all" only supports format "pdf" (Immocloud returns a ZIP of PDFs).',
      );
    }
    return `/operatingcost/${sid}/pdf/all`;
  }
  const tid = encodeImmocloudId(tenancyId, "Tenancy ID");
  return `/operatingcost/${sid}/${format}/${tid}`;
}

export type DownloadedOperatingCostFile = {
  path: string;
  filename: string;
  bytes: number;
  contentType: string;
  statementId: string;
  tenancyId: string | null;
  unitName: string | null;
  tenantName: string | null;
  format: OperatingCostExportFormat | "pdf-zip";
};

export async function downloadOperatingCostExport(
  client: ImmocloudClient,
  options: {
    statementId: string;
    format: OperatingCostExportFormat;
    tenancyId?: string;
    all?: boolean;
    outputDir?: string;
    filename?: string;
    unitName?: string | null;
    tenantName?: string | null;
  },
): Promise<DownloadedOperatingCostFile> {
  const all = options.all === true;
  if (all === Boolean(options.tenancyId)) {
    throw new Error('Pass exactly one of tenancyId or all=true.');
  }

  const apiPath = exportApiPath(
    options.statementId,
    options.format,
    all ? "all" : options.tenancyId!,
  );
  const binary = await client.getBinary(apiPath);
  const dir = resolveDownloadsDir(options.outputDir);
  await mkdir(dir, { recursive: true });

  const ext = all ? "zip" : options.format;
  const defaultName = all
    ? `NK_${slugFilenamePart(options.statementId)}_alle.pdf.zip`
    : [
        "NK",
        options.unitName ? slugFilenamePart(options.unitName) : null,
        options.tenantName ? slugFilenamePart(options.tenantName) : null,
        options.tenancyId ? slugFilenamePart(options.tenancyId, 24) : null,
      ]
        .filter(Boolean)
        .join("_") + `.${ext}`;

  const filename = slugFilenamePart(
    (options.filename?.trim() || binary.filenameHint || defaultName).replace(
      /[\/\\]/g,
      "-",
    ),
    180,
  );
  // Keep extension if slug stripped it awkwardly
  const finalName = filename.includes(".")
    ? filename
    : `${filename}.${ext}`;
  const filePath = path.join(dir, finalName);
  await writeFile(filePath, binary.data);

  return {
    path: filePath,
    filename: finalName,
    bytes: binary.data.byteLength,
    contentType: binary.contentType || MIME_BY_FORMAT[options.format],
    statementId: options.statementId,
    tenancyId: all ? null : options.tenancyId!,
    unitName: options.unitName ?? null,
    tenantName: options.tenantName ?? null,
    format: all ? "pdf-zip" : options.format,
  };
}

export async function downloadAllOperatingCostPdfs(
  client: ImmocloudClient,
  options: {
    statementId: string;
    outputDir?: string;
    includeZipAll?: boolean;
  },
): Promise<{
  statementId: string;
  outputDir: string;
  files: DownloadedOperatingCostFile[];
  tenancyCount: number;
}> {
  const statementId = encodeImmocloudId(options.statementId, "Statement ID");
  const statement = await client.get<unknown>(
    `/operating-cost-v2/${statementId}`,
  );
  const targets = listTenancyTargetsFromStatement(statement);
  if (targets.length === 0) {
    throw new Error(
      "No tenancies found on this operating-cost statement (unitResultList empty).",
    );
  }

  const title =
    typeof statement === "object" &&
    statement !== null &&
    typeof (statement as Record<string, unknown>).title === "string"
      ? slugFilenamePart(String((statement as Record<string, unknown>).title), 40)
      : statementId;
  const outputDir =
    options.outputDir?.trim() || `immocloud-bka/${title || statementId}`;

  const files: DownloadedOperatingCostFile[] = [];
  for (const target of targets) {
    files.push(
      await downloadOperatingCostExport(client, {
        statementId,
        format: "pdf",
        tenancyId: target.tenancyId,
        outputDir,
        unitName: target.unitName,
        tenantName: target.tenantName,
        filename: `NK_${slugFilenamePart(target.unitName || "unit")}_${slugFilenamePart(target.tenantName)}.pdf`,
      }),
    );
  }

  if (options.includeZipAll !== false) {
    files.push(
      await downloadOperatingCostExport(client, {
        statementId,
        format: "pdf",
        all: true,
        outputDir,
        filename: `NK_${slugFilenamePart(title || statementId)}_alle.pdf.zip`,
      }),
    );
  }

  return {
    statementId,
    outputDir: resolveDownloadsDir(outputDir),
    files,
    tenancyCount: targets.length,
  };
}
