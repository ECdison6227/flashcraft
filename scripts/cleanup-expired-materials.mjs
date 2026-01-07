/**
 * Deletes expired CourseCraft files from Supabase Storage and clears file refs in `materials`.
 *
 * Required env:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 * - STORAGE_BUCKET (default: coursecraft-materials)
 * - LIMIT (default: 200)
 */

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || "coursecraft-materials";
const LIMIT = Number.parseInt(process.env.LIMIT || "200", 10);

if (!SUPABASE_URL) throw new Error("Missing env SUPABASE_URL");
if (!SERVICE_ROLE_KEY) throw new Error("Missing env SUPABASE_SERVICE_ROLE_KEY");
if (!Number.isFinite(LIMIT) || LIMIT <= 0) throw new Error("Invalid env LIMIT");

const baseHeaders = {
  apikey: SERVICE_ROLE_KEY,
  authorization: `Bearer ${SERVICE_ROLE_KEY}`,
};

function encodePathSegments(path) {
  return path
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

async function fetchExpiredMaterials() {
  const nowIso = new Date().toISOString();
  const qs = new URLSearchParams({
    select: "id,file_path,expires_at",
    type: "eq.file",
    file_path: "not.is.null",
    expires_at: `lt.${nowIso}`,
    limit: String(LIMIT),
    order: "expires_at.asc",
  });

  const url = `${SUPABASE_URL}/rest/v1/materials?${qs.toString()}`;
  const res = await fetch(url, { headers: { ...baseHeaders, accept: "application/json" } });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Failed to query expired materials (${res.status}): ${bodyText}`);
  }
  return JSON.parse(bodyText);
}

async function deleteStorageObject(filePath) {
  const encoded = encodePathSegments(filePath);
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(STORAGE_BUCKET)}/${encoded}`;

  const res = await fetch(url, { method: "DELETE", headers: { ...baseHeaders } });
  if (res.status === 404) return { ok: true, status: "missing" };
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return { ok: false, status: "error", detail: `(${res.status}) ${bodyText}` };
  }
  return { ok: true, status: "deleted" };
}

async function clearMaterialFileRefs(id) {
  const url = `${SUPABASE_URL}/rest/v1/materials?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      ...baseHeaders,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({ file_url: null, file_path: null }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Failed to patch materials(${id}) (${res.status}): ${bodyText}`);
  }
}

async function main() {
  const expired = await fetchExpiredMaterials();
  console.log(`[cleanup] expired candidates: ${expired.length}`);

  let deleted = 0;
  let missing = 0;
  let failed = 0;

  for (const row of expired) {
    const id = row?.id;
    const filePath = row?.file_path;
    if (!id || !filePath) continue;

    const res = await deleteStorageObject(filePath);
    if (!res.ok) {
      failed += 1;
      console.warn(`[cleanup] delete failed id=${id} path=${filePath} ${res.detail}`);
      // Still clear refs to prevent broken links from persisting forever
    } else if (res.status === "deleted") {
      deleted += 1;
    } else if (res.status === "missing") {
      missing += 1;
    }

    await clearMaterialFileRefs(id);
    console.log(`[cleanup] cleared refs id=${id} (${res.status})`);
  }

  console.log(`[cleanup] done: deleted=${deleted} missing=${missing} failed=${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

