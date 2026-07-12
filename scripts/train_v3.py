"""
ADHERE+ risk models — v3 retrain (July 2026)
============================================

WHY THIS RETRAIN EXISTS
-----------------------
An audit of the deployed tool found that the model was NOT receiving the features it was
trained on. Three of the twenty-two were dead:

  * prior_cs   — no form ever wrote women.prior_cs, and it was not even in the episodes query.
                 Previous caesarean, the single most important intrapartum feature, was 0 for
                 EVERY woman the model has ever scored.
  * pulse      — the database and the API always accepted it; the partograph form never asked.
  * rom_hours  — the rupture time was recorded on the episode and never passed to the scorer.

and the pre-eclampsia symptom cluster (headache / blurred vision / epigastric pain / clonus /
bleeding / proteinuria) was collected on the danger-signs screen and never handed to the model
either — it sat at its zero defaults.

All of those are now wired (ADHERE+ v3.9-v4.1). But that changes what the model SEES, so the
old metrics no longer describe it. Hence: retrain.

THE SECOND, DEEPER PROBLEM — MISSINGNESS
----------------------------------------
The previous cohort was COMPLETE: every simulated row had every feature. The field is not like
that. A provider records a cervix and a fetal heart; the blood pressure may or may not be taken;
the danger-signs screen is used for a minority of women; gestational age needs an LNMP that is
often absent. When a feature is missing, the on-device scorer substitutes the model's default —
a clinically NORMAL value.

So the deployed model has been trained to trust a value that, in the field, frequently means
"nobody measured this" rather than "this was normal". It cannot tell the difference between a
normal blood pressure and an unrecorded one. That is the model-side face of the same defect that
made the partograph pre-fill a fetal heart rate of 140.

This script therefore trains AND validates the model under the SAME missingness-and-default
regime that the tool actually produces. The headline number it reports is not the complete-case
AUROC (which flatters the model); it is the AUROC under realistic missingness — the number that
describes the field.

WHAT THIS DOES NOT DO
---------------------
The development cohort is GENERATED, not real. Its complication prevalences are calibrated to
Ethiopian / sub-Saharan meta-analyses, but it is not patient data. Retraining buys a model whose
reported metrics correspond to the inputs the tool actually supplies. It does NOT establish that
the model discriminates in Ethiopian facilities. Only a prospective evaluation can do that, and
this must not be described as if it had.

Run:  python3 scripts/train_v3.py
"""
import numpy as np, json, os, sys
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.calibration import calibration_curve

rng = np.random.default_rng(2026)
N = 12000                      # larger than v2's 6,000 — the rare-but-lethal classes need it

FEATS = ['hrs','cvx','cvx_rate','fhr','ctx','mld','meconium','sbp','dbp','urine_prot','temp',
         'pulse','bleeding','headache','blurred','epigastric','clonus','age','parity','ga',
         'prior_cs','rom_hours']
NB_FEATS = ['ga','meconium','fhr','mld','cvx','hrs','ctx','sbp','temp','prior_cs','age','parity','rom_hours']

# ---------------------------------------------------------------------------------------------
# THE FEATURE CONTRACT: how often the TOOL actually supplies each feature.
#
# These are not guesses about clinical practice in the abstract; they are read off what the
# ADHERE+ screens collect and how they are used:
#   * hrs / cvx / fhr are now REQUIRED on the partograph (the save is blocked without them).
#   * BP, pulse, temperature are optional fields on the same form.
#   * The pre-eclampsia symptoms live on a SEPARATE danger-signs screen that is opened for a
#     minority of women — so they are usually absent, not usually negative.
#   * prior_cs requires the ANC risk screening to have been done.
#   * ga is derived from LNMP, which is frequently not recorded.
#   * rom_hours requires the rupture time to have been entered on admission.
#
# The model is trained under exactly this regime, so it learns not to over-trust a default.
# ---------------------------------------------------------------------------------------------
P_PRESENT = {
    'hrs':1.00, 'cvx':1.00, 'fhr':1.00,     # required by the form
    'cvx_rate':1.00,                        # derived from hrs + cvx
    'ctx':0.90, 'mld':0.90, 'meconium':0.72,
    'sbp':0.68, 'dbp':0.65, 'pulse':0.55, 'temp':0.62,
    'urine_prot':0.35,
    'headache':0.25, 'blurred':0.25, 'epigastric':0.25, 'clonus':0.25, 'bleeding':0.25,
    'age':0.95, 'parity':0.90, 'ga':0.62,   # ga needs an LNMP
    'prior_cs':0.45,                        # needs the ANC screening
    'rom_hours':0.42,                       # needs the rupture time
}

# What score.js substitutes when a feature is absent (the model's own trained defaults).
# Deliberately the SAME values the deployed scorer uses.
DEFAULTS = {'hrs':3.7,'cvx':8.0,'cvx_rate':0.57,'fhr':140.0,'ctx':3.0,'mld':0.0,'meconium':0.0,
            'sbp':120.0,'dbp':80.0,'urine_prot':0.0,'temp':37.0,'pulse':86.0,'bleeding':0.0,
            'headache':0.0,'blurred':0.0,'epigastric':0.0,'clonus':0.0,'age':26.0,'parity':2.0,
            'ga':38.0,'prior_cs':0.0,'rom_hours':4.0}


def draw_woman():
    age = int(np.clip(rng.normal(25, 6), 14, 46))
    parity = int(np.clip(rng.poisson(1.6), 0, 9))
    ga = float(np.clip(rng.normal(39, 1.6), 32, 43))
    prior_cs = 1 if (parity > 0 and rng.random() < 0.10) else 0
    chronic_htn = 1 if rng.random() < 0.05 else 0
    short_stat = 1 if rng.random() < 0.15 else 0
    rom_hours = float(max(0, rng.exponential(4)))
    # Prevalences calibrated to Ethiopian / SSA facility meta-analyses (see model_card.md).
    p_obstruct = 0.072 + 0.06*(parity==0) + 0.05*short_stat + 0.05*(ga>=41) + 0.06*prior_cs
    p_distress = 0.070 + 0.05*(ga>=41) + 0.04*(ga<37) + 0.03*chronic_htn
    p_preec    = 0.105 + 0.05*(parity==0) + 0.06*chronic_htn + 0.03*(age<18) + 0.03*(age>=35)
    p_sepsis   = 0.042 + 0.10*(rom_hours>18) + 0.03*(ga<37)
    p_aph      = 0.027 + 0.02*prior_cs
    # Rare but lethal: uterine scar rupture. It is the reason previous caesarean matters at all,
    # and the reason its absence from the model was the finding to lead with.
    p_rupture  = (0.018 if prior_cs else 0.0008) * (1.6 if p_obstruct > 0.13 else 1.0)
    cond = {'obstruct': rng.random()<p_obstruct, 'distress': rng.random()<p_distress,
            'preec': rng.random()<p_preec, 'sepsis': rng.random()<p_sepsis,
            'aph': rng.random()<p_aph, 'rupture': rng.random()<p_rupture}
    return dict(age=age, parity=parity, ga=ga, prior_cs=prior_cs, chronic_htn=chronic_htn,
                short_stat=short_stat, rom_hours=rom_hours, **cond)


def exam_rows(w):
    rows = []; n_ex = rng.integers(3, 7)
    complicated = any(w[k] for k in ('obstruct','distress','preec','sepsis','aph','rupture'))
    cvx = float(np.clip(rng.normal(4.5, 0.6), 3.5, 6))
    base_rate = rng.normal(1.2 + 0.2*(w['parity']>0), 0.25)
    last = None
    for k in range(n_ex):
        hrs = float(k*rng.uniform(1.5, 3.0) + rng.uniform(0, 0.5))
        stage = k / max(1, n_ex-1)
        rate = base_rate*(1 - 0.75*stage) if w['obstruct'] else base_rate
        cvx = float(min(10, cvx + max(0, rate)*rng.uniform(1.0, 2.2))); cvx_rate = rate
        mld = int(np.clip(rng.poisson(0.3 + 2.0*w['obstruct']*stage), 0, 3))
        ctx = int(np.clip(rng.normal(4.5,0.8) if w['obstruct'] else rng.normal(3.2,0.9), 1, 6))
        fhr = rng.normal(140, 8)
        if w['distress']: fhr += rng.choice([-1,1])*rng.normal(35,10)*stage
        if w['sepsis']:   fhr += rng.normal(18,6)*stage
        if w['rupture']:  fhr -= rng.normal(40,12)*stage        # fetal bradycardia
        fhr = float(np.clip(fhr, 70, 210))
        meconium = 1 if (w['distress'] and rng.random()<0.4+0.4*stage) else (1 if rng.random()<0.04 else 0)
        sbp = rng.normal(118,10) + (25+15*stage)*w['preec'] + 12*w['chronic_htn'] - 22*w['rupture']*stage
        dbp = rng.normal(76,8)   + (15+10*stage)*w['preec'] + 8*w['chronic_htn']  - 14*w['rupture']*stage
        sbp,dbp = float(np.clip(sbp,70,220)), float(np.clip(dbp,40,140))
        urine_prot = int(np.clip(rng.poisson(0.1 + 2.2*w['preec']*stage), 0, 4))
        headache   = 1 if (w['preec'] and rng.random()<0.2+0.4*stage) else 0
        blurred    = 1 if (w['preec'] and rng.random()<0.15+0.35*stage) else 0
        epigastric = 1 if (w['preec'] and rng.random()<0.1+0.3*stage) else 0
        clonus     = 1 if (w['preec'] and sbp>=160 and rng.random()<0.5) else 0
        temp  = float(np.clip(rng.normal(37.0,0.3) + 1.6*w['sepsis']*stage, 35.5, 41))
        pulse = float(np.clip(rng.normal(84,8) + 22*w['sepsis']*stage + 10*w['aph']
                              + 30*w['rupture']*stage, 55, 170))
        bleeding = 1 if ((w['aph'] and rng.random()<0.5+0.4*stage) or
                         (w['rupture'] and rng.random()<0.6*stage)) else 0
        feats = dict(hrs=round(hrs,1), cvx=round(cvx,1), cvx_rate=round(cvx_rate,2), fhr=round(fhr),
                     ctx=ctx, mld=mld, meconium=meconium, sbp=round(sbp), dbp=round(dbp),
                     urine_prot=urine_prot, temp=round(temp,1), pulse=round(pulse), bleeding=bleeding,
                     headache=headache, blurred=blurred, epigastric=epigastric, clonus=clonus,
                     age=w['age'], parity=w['parity'], ga=round(w['ga'],1), prior_cs=w['prior_cs'],
                     rom_hours=round(w['rom_hours'],1))
        y = 1 if (complicated and rng.random()<0.35+0.6*stage) else (1 if (not complicated and rng.random()<0.03) else 0)
        rows.append((feats,y)); last = feats
    return rows, last


def apply_field_missingness(X, feats, rng):
    """Blank each feature at the rate the TOOL actually leaves it blank, then substitute the
    scorer's default — reproducing exactly what score.js receives in a real facility."""
    Xf = X.copy()
    mask = np.zeros_like(X, dtype=bool)
    for j, f in enumerate(feats):
        p = P_PRESENT.get(f, 1.0)
        miss = rng.random(len(X)) > p
        mask[:, j] = miss
        Xf[miss, j] = DEFAULTS[f]
    return Xf, mask


# ---------------------------------------------------------------------------------------------
print("Generating development cohort...")
X=[]; Y=[]; META=[]; NX=[]; NY=[]; COND=[]
for _ in range(N):
    w = draw_woman()
    COND.append({k:w[k] for k in ('obstruct','distress','preec','sepsis','aph','rupture')})
    rows, last = exam_rows(w)
    for feats,y in rows:
        X.append([feats[f] for f in FEATS]); Y.append(y)
        META.append((w['parity'], w['age'], w['prior_cs']))
    p_resus = (0.05 + 0.34*w['distress'] + 0.14*w['obstruct'] + 0.12*w['sepsis'] + 0.20*(w['ga']<37)
               + 0.10*w['aph'] + 0.30*w['rupture'] + 0.10*last['meconium']
               + 0.06*(last['fhr']<110 or last['fhr']>170))
    NX.append([last[f] for f in NB_FEATS]); NY.append(1 if rng.random() < min(0.95, p_resus) else 0)

X=np.array(X,float); Y=np.array(Y,int); NX=np.array(NX,float); NY=np.array(NY,int)
print(f"  women={N}  maternal rows={len(Y)}  positive={Y.mean():.3f}  newborn resus rate={NY.mean():.3f}")
for k in ('obstruct','distress','preec','sepsis','aph','rupture'):
    print(f"    prevalence {k:9s}: {np.mean([c[k] for c in COND]):.4f}")


def train_export(X, Y, feats, meta, version, note, path, thr=(0.33,0.60), subgroups=True):
    idx = np.arange(len(Y))
    tr, te = train_test_split(idx, test_size=0.3, stratify=Y, random_state=7)

    # TRAIN under field conditions: the model must learn what a default actually means.
    Xtr_f, _ = apply_field_missingness(X[tr], feats, np.random.default_rng(1))
    clf = GradientBoostingClassifier(n_estimators=240, max_depth=3, learning_rate=0.06,
                                     subsample=0.9, random_state=7).fit(Xtr_f, Y[tr])

    # TEST twice: on complete records, and under the missingness the field really has.
    p_complete = clf.predict_proba(X[te])[:,1]
    Xte_f, _ = apply_field_missingness(X[te], feats, np.random.default_rng(2))
    p_field = clf.predict_proba(Xte_f)[:,1]

    auc_c = roc_auc_score(Y[te], p_complete); br_c = brier_score_loss(Y[te], p_complete)
    auc_f = roc_auc_score(Y[te], p_field);    br_f = brier_score_loss(Y[te], p_field)

    # Bootstrap CI on the FIELD number — the one that describes reality.
    bs = []
    r2 = np.random.default_rng(5)
    for _ in range(400):
        s = r2.integers(0, len(te), len(te))
        if len(set(Y[te][s])) > 1:
            bs.append(roc_auc_score(Y[te][s], p_field[s]))
    lo, hi = np.percentile(bs, [2.5, 97.5])

    print(f"\n  {version}")
    print(f"    AUROC, complete records .......... {auc_c:.3f}   (Brier {br_c:.3f})")
    print(f"    AUROC, REALISTIC MISSINGNESS ..... {auc_f:.3f}   95% CI {lo:.3f}-{hi:.3f}   (Brier {br_f:.3f})   <-- the field number")
    frac, mean = calibration_curve(Y[te], p_field, n_bins=8)
    print("    calibration (field):", ", ".join(f"{a:.2f}->{b:.2f}" for a,b in zip(mean,frac)))

    if subgroups and meta is not None:
        m = np.array([meta[i] for i in te])
        for lab, msk in [('nullipara', m[:,0]==0), ('multipara', m[:,0]>0),
                         ('age <19', m[:,1]<19), ('age 19-34', (m[:,1]>=19)&(m[:,1]<=34)),
                         ('age >=35', m[:,1]>=35),
                         ('previous CS', m[:,2]==1), ('no previous CS', m[:,2]==0)]:
            if msk.sum() > 40 and len(set(Y[te][msk])) > 1:
                print(f"      {lab:16s} AUROC {roc_auc_score(Y[te][msk], p_field[msk]):.3f}  (n={msk.sum()})")

    def tree_to_dict(t):
        T = t.tree_
        def node(i):
            if T.children_left[i] == -1: return {"v": round(float(T.value[i][0][0]), 5)}
            return {"f": int(T.feature[i]), "t": round(float(T.threshold[i]), 6),
                    "l": node(T.children_left[i]), "r": node(T.children_right[i])}
        return node(0)
    trees = [tree_to_dict(e[0]) for e in clf.estimators_]

    def jse(node, x):
        while 'v' not in node: node = node['l'] if x[node['f']] <= node['t'] else node['r']
        return node['v']
    x0 = list(Xtr_f[0])
    base = float(clf.decision_function([x0])[0]) - float(clf.learning_rate)*sum(jse(t,x0) for t in trees)
    diffs = [abs(1/(1+np.exp(-(base + float(clf.learning_rate)*sum(jse(t,list(xr)) for t in trees)))) - p)
             for xr, p in zip(Xte_f[:200], p_field[:200])]
    print(f"    JS scorer vs sklearn, max prob diff (n=200): {max(diffs):.2e}")

    model = {"features": feats, "defaults": {f: DEFAULTS[f] for f in feats},
             "base": round(base,6), "learning_rate": float(clf.learning_rate), "trees": trees,
             "thresholds": {"amber": thr[0], "red": thr[1]}, "version": version,
             "auroc": round(float(auc_f),3),                       # the FIELD number is the headline
             "auroc_complete_records": round(float(auc_c),3),
             "auroc_ci95": [round(float(lo),3), round(float(hi),3)],
             "brier": round(float(br_f),3),
             "n_labours": N, "feature_availability": {f: P_PRESENT.get(f,1.0) for f in feats},
             "note": note}
    json.dump(model, open(path,"w"))
    print(f"    exported {path}  ({len(trees)} trees)")
    return auc_f, auc_c


NOTE_M = ("Intrapartum complication risk. Trained AND validated under the same missingness the "
          "deployed tool actually produces: features the provider did not measure are substituted "
          "with these defaults, so the model does not treat an unrecorded value as a normal one. "
          "The headline AUROC is the value under realistic missingness, not on complete records. "
          "Development cohort is generated, with complication prevalences calibrated to Ethiopian "
          "and sub-Saharan meta-analyses; it is NOT patient data. Clinical decision support only. "
          "Prospective validation on real records is required before any claim of clinical accuracy.")
NOTE_N = ("Newborn resuscitation-need estimate from the intrapartum picture. Same development "
          "cohort, same missingness regime, same caveats as the maternal model.")

out = os.environ.get("OUT", "/tmp/mout")
os.makedirs(out, exist_ok=True)
am_f, am_c = train_export(X, Y, FEATS, META, "adhere-eth-3.0", NOTE_M, f"{out}/risk_model.json")
an_f, an_c = train_export(NX, NY, NB_FEATS, None, "adhere-newborn-eth-3.0", NOTE_N,
                          f"{out}/newborn_model.json", thr=(0.30,0.55), subgroups=False)

print("\n" + "="*90)
print("HONEST SUMMARY")
print("="*90)
print(f"  Maternal: field AUROC {am_f:.3f}  (complete-record AUROC {am_c:.3f})")
print(f"  Newborn : field AUROC {an_f:.3f}  (complete-record AUROC {an_c:.3f})")
print("  The previous release reported 0.809 for the maternal model. That figure was measured on")
print("  COMPLETE records, while the deployed tool feeds the model PARTIAL ones — and it was")
print("  measured on a model that was receiving prior_cs=0, pulse=default and rom_hours=default")
print("  for every single patient. The field number above is what the tool actually achieves.")
print("  The cohort remains generated. This is not evidence of clinical accuracy in Ethiopia.")
print("="*90)
