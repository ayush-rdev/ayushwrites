// ─────────────────────────────────────────────
//  Image helpers for the admin editors.
//  (The rich text toolbar itself is handled by
//  @toast-ui/editor; this module only covers the
//  upload pipeline.)
// ─────────────────────────────────────────────

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB — plenty for a blog

/** File → base64 data string (no prefix), promise-wrapped */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = String(r.result || '');
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

/** 'My Photo (2).PNG' → 'my-photo-2' */
export function baseName(name) {
  return String(name)
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build a unique filename + repo path for an uploaded image.
 * Returns { filename, path } — e.g. '20260809-m3k2x-my-photo.png',
 * 'public/images/20260809-m3k2x-my-photo.png'
 */
export function imagePathFor(file) {
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = `${stamp}-${Date.now().toString(36)}-${baseName(file.name)}.${ext}`;
  return { filename, path: `public/images/${filename}` };
}
