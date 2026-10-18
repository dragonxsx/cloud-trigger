import type { ImportIssue } from '@cloud-trigger/engine';
import { parseAllDocuments, stringify } from 'yaml';

export const toYaml = (docs: readonly unknown[]): string =>
  docs.map((doc) => stringify(doc, { lineWidth: 0 })).join('---\n');

export function fromYaml(text: string): { values: unknown[]; issues: ImportIssue[] } {
  const values: unknown[] = [];
  const issues: ImportIssue[] = [];
  for (const [document, doc] of parseAllDocuments(text).entries()) {
    if (doc.errors.length > 0) {
      issues.push(
        ...doc.errors.map((e) => ({ document, name: null, path: 'yaml', message: e.message })),
      );
    } else {
      const value: unknown = doc.toJS();
      if (value !== null) {
        values.push(value);
      }
    }
  }

  return { values, issues };
}
