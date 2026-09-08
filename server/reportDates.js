"use strict";
// Collector policy, independent of the immutable wire schemas. This generous
// floor preserves supported 2020-era backlogs and predates the 2026 launch.
// Never let pre-service timestamps determine a shared history window.
const FIRST_REPORT_DATE = "2020-01-01";
module.exports = { FIRST_REPORT_DATE };
