export const QUALITY_PROFILES = Object.freeze({
  best: Object.freeze({
    label: 'Best available - MKV',
    format: 'bv*+ba/b',
  }),
  1080: Object.freeze({
    label: 'Up to 1080p - MKV',
    format: 'bv*[height<=1080]+ba/b[height<=1080]/b',
  }),
  720: Object.freeze({
    label: 'Up to 720p - MKV',
    format: 'bv*[height<=720]+ba/b[height<=720]/b',
  }),
});

export const QUALITY_VALUES = Object.freeze(['best', '1080', '720']);

export function isQualityProfile(value) {
  return typeof value === 'string' && Object.hasOwn(QUALITY_PROFILES, value);
}

export function publicQualityOptions() {
  return QUALITY_VALUES.map((value) => ({ value, label: QUALITY_PROFILES[value].label }));
}
