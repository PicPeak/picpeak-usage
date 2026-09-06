import v2 from "../protocol/features.v2.json";
import v3 from "../protocol/features.v3.json";
import v4 from "../protocol/features.v4.json";

export const catalog = v4;
// Keep retired questions available for historical comparisons under their
// original names. They are distinct measurements, never aliases.
export const historicalFeatures = { ...v2.features, ...v3.features, ...v4.features };
