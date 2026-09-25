// 替代规则版本与候选评分。规则以版本为单位不可变：更正规则等于登记新版本，
// 失效日选择“在失效当日已生效”的最高版本，保证历史决策可还原。

export function defaultPolicy() {
  return {
    version: "quote-substitution-1",
    effective_from: "2000-01-01",
    timezone: "Asia/Shanghai",
    maximum_quality_delta: 1,
    quality_scale: {economy: -1, standard: 0, premium: 1},
    // 门店层级与地区为硬约束；质量差异在阈值内按差距最小优先。
    match_region: true,
    match_store_tier: true,
    // 自动替代决定的审批依据基线；人工审批可在触发时覆盖。
    approval_ref: "baseline:quote-substitution-1",
  };
}

export function selectPolicy(policies, date) {
  const effective = policies
    .filter((p) => p.effective_from <= date)
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
  return effective[0] ?? defaultPolicy();
}

export function qualityRank(grade, policy) {
  const scale = policy.quality_scale || {};
  if (Object.hasOwn(scale, grade)) return scale[grade];
  // 未登记的等级按数字后缀尝试，无法判断时放到最远端，避免静默拉近质量差。
  const asNumber = Number.parseInt(String(grade).replace(/[^-\d]/g, ""), 10);
  return Number.isFinite(asNumber) ? asNumber : Number.POSITIVE_INFINITY;
}

/**
 * 评估一个候选点是否可在失效日采用。
 * 返回 {eligible, reasons}，reasons 同时用于保存“未采用原因”。
 */
export function evaluateCandidate(candidate, context, policy) {
  const reasons = [];
  if (candidate.eligible === false) reasons.push("candidate_marked_ineligible");
  if (candidate.valid_from && candidate.valid_from > context.date) reasons.push("candidate_not_yet_valid");
  if (candidate.valid_to && candidate.valid_to < context.date) reasons.push("candidate_expired");
  if (policy.match_region && candidate.region !== context.region) reasons.push("region_mismatch");
  if (policy.match_store_tier && candidate.store_tier !== context.store_tier) reasons.push("store_tier_mismatch");
  if (candidate.product_sku !== context.product_sku) reasons.push("product_sku_mismatch");

  const delta = Math.abs(
    qualityRank(candidate.quality_grade, policy) - qualityRank(context.quality_grade, policy),
  );
  if (delta > policy.maximum_quality_delta) reasons.push("quality_delta_exceeds_max");

  return {eligible: reasons.length === 0, quality_delta: delta, reasons};
}

/**
 * 在全部候选里做选择：不合格的记录排除原因，合格者按
 * 质量差 → 优先级 → 候选编号排序，落选合格候选也保存落败原因。
 */
export function chooseCandidates(candidates, context, policy) {
  const considered = [];
  const qualified = [];
  for (const candidate of candidates) {
    const result = evaluateCandidate(candidate, context, policy);
    const entry = {
      candidate_id: candidate.candidate_id,
      point_id: candidate.point_id,
      quality_grade: candidate.quality_grade,
      valid_from: candidate.valid_from ?? null,
      valid_to: candidate.valid_to ?? null,
      quality_delta: result.quality_delta,
      eligible: result.eligible,
      selected: false,
      reasons: result.reasons,
    };
    considered.push(entry);
    if (result.eligible) qualified.push({candidate, entry});
  }
  qualified.sort((a, b) => {
    if (a.entry.quality_delta !== b.entry.quality_delta) {
      return a.entry.quality_delta - b.entry.quality_delta;
    }
    const pa = a.candidate.priority ?? 100;
    const pb = b.candidate.priority ?? 100;
    if (pa !== pb) return pa - pb;
    return a.candidate.candidate_id < b.candidate.candidate_id ? -1 : 1;
  });

  const winner = qualified[0] ?? null;
  if (winner) {
    winner.entry.selected = true;
    for (const {entry} of qualified.slice(1)) {
      entry.reasons.push("lost_to_higher_ranked_candidate");
    }
  }
  return {selected: winner?.candidate ?? null, considered};
}
