// Re-export the shared implementation so existing web imports keep working.
// Source of truth: packages/neige-web-shared/src/clipboard.ts
export { writeClipboard, writeClipboardSync } from '@neige/shared';
