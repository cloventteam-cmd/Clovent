import { CRM_FIELD_MAPS } from '../shared/constants';
import type { FieldMapping, MappingRule, ImportSourceType } from '../shared/types';
import { normalizePhone, normalizeEmail, parseDate } from '../shared/utils';

export class FieldMapper {
  private mapping: FieldMapping;
  private sourceType: ImportSourceType;
  private baseMap: Record<string, string>;

  constructor(mapping: FieldMapping, sourceType: ImportSourceType) {
    this.mapping = mapping;
    this.sourceType = sourceType;
    this.baseMap = (CRM_FIELD_MAPS as any)[sourceType] ?? {};
  }

  map(raw: Record<string, string>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // Apply CRM base field map first
    for (const [sourceField, targetField] of Object.entries(this.baseMap)) {
      if (raw[sourceField] !== undefined) {
        result[targetField] = raw[sourceField];
      }
    }

    // Apply user-defined overrides
    for (const [targetField, rule] of Object.entries(this.mapping)) {
      if (typeof rule === 'string') {
        if (raw[rule] !== undefined) result[targetField] = raw[rule];
      } else {
        const mappingRule = rule as MappingRule;
        const rawValue = raw[mappingRule.source_field];
        result[targetField] = rawValue !== undefined
          ? this.applyTransform(rawValue, mappingRule.transform)
          : (mappingRule.default_value ?? null);
      }
    }

    return result;
  }

  private applyTransform(value: string, transform?: MappingRule['transform']): unknown {
    if (!transform) return value;
    switch (transform) {
      case 'lowercase': return value.toLowerCase();
      case 'uppercase': return value.toUpperCase();
      case 'trim': return value.trim();
      case 'phone_normalize': return normalizePhone(value) ?? value;
      case 'date_parse': return parseDate(value);
      case 'boolean': return ['true', '1', 'yes', 'y'].includes(value.toLowerCase());
      default: return value;
    }
  }

  // Auto-detect field mapping from CSV headers
  static detectMapping(
    headers: string[],
    sourceType: ImportSourceType,
  ): FieldMapping {
    const baseMap = (CRM_FIELD_MAPS as any)[sourceType] ?? {};
    const detected: FieldMapping = {};

    // Reverse the base map for detection
    const reverseBase = Object.fromEntries(
      Object.entries(baseMap).map(([k, v]) => [v as string, k]),
    );

    const genericPatterns: Record<string, RegExp[]> = {
      first_name: [/first.?name/i, /fname/i],
      last_name: [/last.?name/i, /lname/i, /surname/i],
      email: [/email/i, /e.?mail/i],
      phone: [/phone/i, /mobile/i, /cell/i],
      phone_alt: [/phone.?2/i, /alt.?phone/i, /secondary.?phone/i],
      city: [/city/i],
      state: [/state/i, /province/i],
      zip: [/zip/i, /postal/i],
      source: [/source/i, /lead.?source/i],
      type: [/type/i, /lead.?type/i, /contact.?type/i],
      tags: [/tag/i, /label/i],
      notes: [/note/i, /comment/i, /description/i],
    };

    for (const header of headers) {
      // Check base map first
      if (baseMap[header]) {
        detected[baseMap[header] as string] = header;
        continue;
      }

      // Try generic patterns
      for (const [target, patterns] of Object.entries(genericPatterns)) {
        if (patterns.some(p => p.test(header))) {
          if (!detected[target]) detected[target] = header;
          break;
        }
      }
    }

    return detected;
  }
}
