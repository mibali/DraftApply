export function evaluateGroundingCases(results) {
  const unsupported = results.filter(row => !row.supported);
  const supported = results.filter(row => row.supported);
  const credentialUnsupported = unsupported.filter(row => row.credential);
  const passed = row => row.result.status === 'pass';
  return {
    unsupportedClaimRate: results.filter(row => passed(row) && !row.supported).length / Math.max(1, results.length),
    unsupportedClaimRecall: unsupported.filter(row => !passed(row)).length / Math.max(1, unsupported.length),
    supportedClaimRejection: supported.filter(row => !passed(row)).length / Math.max(1, supported.length),
    credentialFalsePositiveRate: credentialUnsupported.filter(passed).length / Math.max(1, credentialUnsupported.length),
  };
}
