/* Module 3 — Bayesian longitudinal maternal-risk tracker.
   Sequential Bayesian log-odds updating across the continuum (ANC -> labour -> PNC).
   Prior from population base rate; each observed finding contributes log(likelihood ratio).
   Posterior after each visit becomes the prior for the next. Tracks the risk trajectory.
   Likelihood ratios reflect published obstetric associations (documented in model_card.md). */
(function(global){
  // finding -> approximate likelihood ratio for a significant intrapartum complication
  const LR = {
    age_lt16:1.6, age_ge35:1.5, nullipara:1.4, grand_multipara:1.6, prior_cs:2.0,
    prev_stillbirth:1.8, short_stature:1.5, preterm:1.7, postterm:1.6,
    bp_ge140:2.6, bp_ge160:4.0, proteinuria:2.4, headache:1.8, blurred_vision:1.9, epigastric:2.0, clonus:4.5,
    slow_progress:2.8, moulding_ge2:3.0, fhr_abnormal:3.2, meconium:2.6,
    fever_ge38:2.5, prolonged_rom:2.2, bleeding:3.5, weak_contractions:1.6
  };
  function logit(p){ return Math.log(p/(1-p)); }
  function sigmoid(z){ return 1/(1+Math.exp(-z)); }
  function BayesTracker(baseRate){
    this.logodds = logit(baseRate || 0.15);   // population prior
    this.evidence = 0;                          // count of informative findings (uncertainty proxy)
    this.history = [];
  }
  // findings: array of finding keys observed at this visit (only NEW/active ones)
  BayesTracker.prototype.update = function(findings, label){
    (findings||[]).forEach(f => { if(LR[f]){ this.logodds += Math.log(LR[f]); this.evidence++; } });
    var p = sigmoid(this.logodds);
    var band = p>=0.60?'red':(p>=0.33?'amber':'green');
    // crude credible half-width shrinking with evidence (illustrative uncertainty)
    var hw = 1/Math.sqrt(4+this.evidence);
    var rec = { at: label||new Date().toISOString(), probability:p, band:band,
                ci:[Math.max(0,p-hw), Math.min(1,p+hw)], evidence:this.evidence };
    this.history.push(rec);
    return rec;
  };
  BayesTracker.LR = LR;
  global.BayesTracker = BayesTracker;
})(typeof window!=='undefined'?window:global);
if(typeof module!=='undefined') module.exports = (typeof window!=='undefined'?window:global).BayesTracker;
