export function resolveFollowerSnapshot({ selectedPeriodSnapshot, latestSnapshot }) {
  const snapshot = selectedPeriodSnapshot || latestSnapshot || null

  if (!snapshot || snapshot.followersCount == null) {
    return {
      followerCount: null,
      snapshotDate: null,
      snapshotSource: "unavailable",
      hasSelectedPeriodSnapshot: false,
    }
  }

  return {
    followerCount: Number(snapshot.followersCount),
    snapshotDate: snapshot.snapshotDate,
    snapshotSource: selectedPeriodSnapshot ? "selected_period" : "latest_fallback",
    hasSelectedPeriodSnapshot: Boolean(selectedPeriodSnapshot),
  }
}

export function calculateAvailableChangePct(current, previous) {
  if (current == null || previous == null || Number(previous) === 0) return null
  return Number((((Number(current) - Number(previous)) / Number(previous)) * 100).toFixed(1))
}
