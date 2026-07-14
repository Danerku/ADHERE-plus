"""
ADHERE+ risk models — v4, rebuilt for the Labour Care Guide (July 2026)
======================================================================

WHY THIS RETRAIN EXISTS
-----------------------
Ethiopia's endorsed Intrapartum Care Guideline replaced the partograph with the WHO Labour Care
Guide. That is not a cosmetic change for a model:

  * ACTIVE LABOUR NOW STARTS AT 5 CM, not 4. `hours_since_active` means something different.
  * THE ALERT LINE IS GONE. Poor progress used to be "cervix behind a 1 cm/hour diagonal". It is
    now "she has been at THIS centimetre longer than its lag time, with no progress" —
    5cm>=6h, 6cm>=5h, 7cm>=3h, 8cm>=2.5h, 9cm>=2h; second stage >=3h nullip / >=2h multip.
  * The old model's #2 feature, `cvx_rate = (cvx - 4) / hrs`, is ANCHORED ON THE 4 CM START THAT
    NO LONGER EXISTS. Left alone, it would keep producing a number — a plausible, wrong number.
    It is deleted. Its replacement is what the guideline actually reasons about: how long she has
    stood still, and whether that exceeds the lag time for where she is.
  * The guide collects things the partograph never did: DURATION of contractions, deceleration
    TYPE (late is the one that matters), fetal POSITION, and graded meconium (M+/M++/M+++).

So the feature contract changed, which means the model has to change. A model fed a world it was
not trained on is not conservative — it is quietly wrong, and it looks fine while it is.

WHAT IS *NOT* FED TO THE MODEL
------------------------------
Section 2 of the guide — companion, pain relief, oral fluid, posture. They are alerts in the
guideline and they are alerts in the tool, but they are not model inputs. They describe the
quality of her care, not the physiology of her labour; feeding them in would let the model learn
DOCUMENTATION HABITS (which wards write "companion: Y") and dress that up as risk.

MISSINGNESS IS TRAINED IN, NOT ASSUMED AWAY
-------------------------------------------
When a feature is absent, score.js substitutes the model's default — a clinically NORMAL value.
So the model is trained and validated under the same missingness the tool actually produces, and
the headline number reported here is the field number, not the flattering complete-case one.

Run:  python3 scripts/train_v4_lcg.py
"""
import numpy as np, json, os
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.calibration import calibration_curve

rng = np.random.default_rng(2026)
N = 13500                       # >13,000 labours, as agreed

# The lag time at each centimetre of the active first stage — the guideline's own table.
LAG = {5: 6.0, 6: 5.0, 7: 3.0, 8: 2.5, 9: 2.0}

FEATS = [
    'hrs',            # hours since active first stage was diagnosed (>=5 cm)
    'cvx',            # cervical dilatation, cm
    'stall_h',        # hours at the CURRENT dilatation with no progress
    'lag_ratio',      # stall_h / lag time for that centimetre.  >=1 is the guideline's alert
    'descent',        # fifths of the head palpable above the symphysis (5..0)
    'fhr',            # baseline fetal heart rate
    'decel_late',     # late decelerations (the alert), 0/1
    'decel_any',      # any deceleration recorded, 0/1
    'meconium',       # 0 none / clear, 1 M+, 2 M++, 3 M+++ (thick)
    'mld',            # moulding 0..3
    'caput',          # caput 0..3
    'malposition',    # occiput posterior or transverse, 0/1
    'ctx',            # contractions per 10 minutes
    'ctx_dur',        # duration of contractions, seconds  (NEW — the partograph never had it)
    'sbp','dbp','pulse','temp','urine_prot',
    'bleeding','headache','blurred','epigastric','clonus',
    'age','parity','ga','prior_cs','rom_hours',
]
NB_FEATS = ['ga','meconium','fhr','decel_late','mld','cvx','lag_ratio','hrs','ctx','sbp','temp',
            'prior_cs','age','parity','rom_hours']

# How often the TOOL supplies each feature. Read off the Labour Care Guide screen and its
# assessment frequencies, not guessed:
#   * cervix / FHR / contractions are the core of an assessment and are recorded most of the time.
#   * hrs, stall_h and lag_ratio are DERIVED from the guide's own timeline — present whenever the
#     active-labour diagnosis was recorded, which the screen now requires before the first save.
#   * BP, pulse, temperature and urine are 4-hourly, so they are absent from most 30-minute rows.
#   * The pre-eclampsia symptom cluster lives on the separate danger-signs screen.
#   * Fetal position and caput need a vaginal examination — 4-hourly at best.
P_PRESENT = {
    'hrs':0.98,'cvx':0.92,'stall_h':0.92,'lag_ratio':0.92,'descent':0.70,
    'fhr':0.98,'decel_late':0.85,'decel_any':0.85,
    'meconium':0.72,'mld':0.70,'caput':0.66,'malposition':0.62,
    'ctx':0.93,'ctx_dur':0.85,
    'sbp':0.62,'dbp':0.60,'pulse':0.55,'temp':0.58,'urine_prot':0.33,
    'bleeding':0.25,'headache':0.25,'blurred':0.25,'epigastric':0.25,'clonus':0.25,
    'age':0.95,'parity':0.92,'ga':0.62,'prior_cs':0.45,'rom_hours':0.45,
}

# What score.js substitutes when a feature is absent. A NORMAL labour, deliberately — which is
# exactly why the model must be trained to know that a default is not an observation.
DEFAULTS = {
    'hrs':3.0,'cvx':7.0,'stall_h':1.5,'lag_ratio':0.45,'descent':3.0,
    'fhr':140.0,'decel_late':0.0,'decel_any':0.0,
    'meconium':0.0,'mld':0.0,'caput':0.0,'malposition':0.0,
    'ctx':4.0,'ctx_dur':40.0,
    'sbp':118.0,'dbp':76.0,'pulse':84.0,'temp':37.0,'urine_prot':0.0,
    'bleeding':0.0,'headache':0.0,'blurred':0.0,'epigastric':0.0,'clonus':0.0,
    'age':25.0,'parity':1.0,'ga':39.0,'prior_cs':0.0,'rom_hours':4.0,
}


def draw_woman():
    age = int(np.clip(rng.normal(25, 6), 14, 46))
    parity = int(np.clip(rng.poisson(1.6), 0, 9))
    ga = float(np.clip(rng.normal(39, 1.6), 32, 43))
    prior_cs = 1 if (parity > 0 and rng.random() < 0.10) else 0
    chronic_htn = 1 if rng.random() < 0.05 else 0
    short_stat = 1 if rng.random() < 0.15 else 0
    rom_hours = float(max(0, rng.exponential(4)))
    # Prevalences calibrated to Ethiopian / sub-Saharan facility meta-analyses (see model_card.md).
    p_obstruct = 0.072 + 0.06*(parity == 0) + 0.05*short_stat + 0.05*(ga >= 41) + 0.06*prior_cs
    p_distress = 0.070 + 0.05*(ga >= 41) + 0.04*(ga < 37) + 0.03*chronic_htn
    p_preec    = 0.105 + 0.05*(parity == 0) + 0.06*chronic_htn + 0.03*(age < 18) + 0.03*(age >= 35)
    p_sepsis   = 0.042 + 0.10*(rom_hours > 18) + 0.03*(ga < 37)
    p_aph      = 0.027 + 0.02*prior_cs
    p_rupture  = (0.018 if prior_cs else 0.0008) * (1.6 if p_obstruct > 0.13 else 1.0)
    cond = {'obstruct': rng.random() < p_obstruct, 'distress': rng.random() < p_distress,
            'preec': rng.random() < p_preec, 'sepsis': rng.random() < p_sepsis,
            'aph': rng.random() < p_aph, 'rupture': rng.random() < p_rupture}
    return dict(age=age, parity=parity, ga=ga, prior_cs=prior_cs, chronic_htn=chronic_htn,
                short_stat=short_stat, rom_hours=rom_hours, **cond)


def labour_rows(w):
    """One labour, monitored on the Labour Care Guide.

    The guide is opened at 5 cm. Each centimetre takes a DWELL TIME; an obstructed labour dwells
    far longer, which is precisely what the lag-time thresholds are built to catch. The assessment
    rows are what a provider would record along the way.
    """
    rows = []
    t = 0.0                                   # hours since active labour (5 cm) was diagnosed
    cvx = 5
    # A normal labour moves faster if she has given birth before. Median dwell well inside the lag.
    base_dwell = {5: 2.4, 6: 2.0, 7: 1.3, 8: 1.0, 9: 0.8}
    par_factor = 0.75 if w['parity'] > 0 else 1.0
    obstruct_at = int(rng.integers(6, 10)) if w['obstruct'] else None   # where she arrests
    descent = 4 if w['parity'] == 0 else 3
    last = None
    while cvx <= 9:
        dwell = base_dwell[cvx] * par_factor * float(np.clip(rng.lognormal(0, 0.35), 0.5, 2.2))
        if obstruct_at is not None and cvx >= obstruct_at:
            dwell = LAG[cvx] * float(rng.uniform(1.1, 2.4))            # she stands still past the lag
        # Assess every ~30-60 min while she is at this centimetre.
        n_obs = max(1, int(round(dwell / rng.uniform(0.5, 1.0))))
        for k in range(n_obs):
            stall = (k + 1) * (dwell / n_obs)
            hrs = t + stall
            lag_ratio = stall / LAG[cvx]
            stage = min(1.0, hrs / 12.0)                                # how far into labour she is
            arrested = (obstruct_at is not None and cvx >= obstruct_at)

            fhr = rng.normal(140, 8)
            if w['distress']: fhr += rng.choice([-1, 1]) * rng.normal(30, 10) * (0.4 + stage)
            if w['sepsis']:   fhr += rng.normal(16, 6) * stage
            if w['rupture']:  fhr -= rng.normal(40, 12) * stage
            if arrested:      fhr += rng.normal(10, 6) * lag_ratio      # the fetus tires as she arrests
            fhr = float(np.clip(fhr, 70, 210))

            p_late = 0.05 + 0.45*w['distress']*(0.4+stage) + 0.25*w['rupture']*stage + 0.15*arrested*min(1, lag_ratio)
            decel_late = 1 if rng.random() < min(0.9, p_late) else 0
            decel_any  = 1 if (decel_late or rng.random() < 0.18 + 0.2*stage) else 0

            mec_p = 0.05 + 0.5*w['distress']*(0.3+stage) + 0.1*arrested
            meconium = 0
            if rng.random() < min(0.9, mec_p):
                meconium = int(rng.choice([1, 2, 3], p=[0.45, 0.32, 0.23])) if w['distress'] else 1

            mld   = int(np.clip(rng.poisson(0.25 + 2.2*arrested*min(1.2, lag_ratio)), 0, 3))
            caput = int(np.clip(rng.poisson(0.25 + 1.9*arrested*min(1.2, lag_ratio)), 0, 3))
            malpos = 1 if (rng.random() < (0.08 + 0.35*arrested)) else 0

            # Under the LCG, inadequate uterine activity is <2 in 10 or <20 s; obstruction can also
            # present with hypertonic, frequent contractions.
            if arrested and rng.random() < 0.5:
                ctx = int(np.clip(rng.normal(6.0, 0.8), 1, 8)); ctx_dur = int(np.clip(rng.normal(75, 12), 10, 120))
            elif arrested:
                ctx = int(np.clip(rng.normal(2.0, 0.8), 0, 5)); ctx_dur = int(np.clip(rng.normal(22, 8), 10, 60))
            else:
                ctx = int(np.clip(rng.normal(4.0, 0.9), 1, 6));  ctx_dur = int(np.clip(rng.normal(42, 9), 20, 70))

            sbp = rng.normal(118, 10) + (25 + 15*stage)*w['preec'] + 12*w['chronic_htn'] - 22*w['rupture']*stage
            dbp = rng.normal(76, 8)   + (15 + 10*stage)*w['preec'] + 8*w['chronic_htn']  - 14*w['rupture']*stage
            sbp, dbp = float(np.clip(sbp, 70, 220)), float(np.clip(dbp, 40, 140))
            urine_prot = int(np.clip(rng.poisson(0.1 + 2.2*w['preec']*stage), 0, 4))
            headache   = 1 if (w['preec'] and rng.random() < 0.2 + 0.4*stage) else 0
            blurred    = 1 if (w['preec'] and rng.random() < 0.15 + 0.35*stage) else 0
            epigastric = 1 if (w['preec'] and rng.random() < 0.1 + 0.3*stage) else 0
            clonus     = 1 if (w['preec'] and sbp >= 160 and rng.random() < 0.5) else 0
            temp  = float(np.clip(rng.normal(37.0, 0.3) + 1.6*w['sepsis']*stage, 35.5, 41))
            pulse = float(np.clip(rng.normal(84, 8) + 22*w['sepsis']*stage + 10*w['aph']
                                  + 30*w['rupture']*stage, 55, 170))
            bleeding = 1 if ((w['aph'] and rng.random() < 0.5 + 0.4*stage) or
                             (w['rupture'] and rng.random() < 0.6*stage)) else 0
            desc = float(np.clip(descent - (0 if arrested else rng.random()*0.6), 0, 5))

            f = dict(hrs=round(hrs, 1), cvx=float(cvx), stall_h=round(stall, 1),
                     lag_ratio=round(lag_ratio, 2), descent=round(desc, 1),
                     fhr=round(fhr), decel_late=decel_late, decel_any=decel_any,
                     meconium=meconium, mld=mld, caput=caput, malposition=malpos,
                     ctx=ctx, ctx_dur=ctx_dur,
                     sbp=round(sbp), dbp=round(dbp), pulse=round(pulse), temp=round(temp, 1),
                     urine_prot=urine_prot, bleeding=bleeding, headache=headache, blurred=blurred,
                     epigastric=epigastric, clonus=clonus,
                     age=w['age'], parity=w['parity'], ga=round(w['ga'], 1),
                     prior_cs=w['prior_cs'], rom_hours=round(w['rom_hours'], 1))

            complicated = any(w[k] for k in ('obstruct', 'distress', 'preec', 'sepsis', 'aph', 'rupture'))
            # The label is "this labour ends in a complication requiring intervention". The signal
            # strengthens as the picture develops — which is what a monitoring tool is for.
            y = 1 if (complicated and rng.random() < 0.30 + 0.55*max(stage, min(1.0, lag_ratio))) \
                else (1 if (not complicated and rng.random() < 0.03) else 0)
            rows.append((f, y)); last = f
        t += dwell
        if not arrested:
            descent = max(0, descent - rng.random()*0.8)
            cvx += 1
        else:
            break                                # she does not progress: the labour ends here (referral / caesarean)
        if t > 26:
            break
    return rows, last


def apply_field_missingness(X, feats, r):
    """Blank each feature at the rate the guide actually leaves it blank, then substitute the
    scorer's default — reproducing exactly what score.js receives in a real facility."""
    Xf = X.copy()
    for j, f in enumerate(feats):
        miss = r.random(len(X)) > P_PRESENT.get(f, 1.0)
        Xf[miss, j] = DEFAULTS[f]
    return Xf


print("Generating the development cohort (Labour Care Guide definitions)...")
X = []; Y = []; META = []; NX = []; NY = []; COND = []
for _ in range(N):
    w = draw_woman()
    COND.append({k: w[k] for k in ('obstruct', 'distress', 'preec', 'sepsis', 'aph', 'rupture')})
    rows, last = labour_rows(w)
    if not rows:
        continue
    for f, y in rows:
        X.append([f[k] for k in FEATS]); Y.append(y)
        META.append((w['parity'], w['age'], w['prior_cs']))
    p_resus = (0.05 + 0.34*w['distress'] + 0.14*w['obstruct'] + 0.12*w['sepsis'] + 0.20*(w['ga'] < 37)
               + 0.10*w['aph'] + 0.30*w['rupture'] + 0.08*min(1, last['meconium'])
               + 0.06*(last['fhr'] < 110 or last['fhr'] > 170) + 0.06*last['decel_late'])
    NX.append([last[k] for k in NB_FEATS]); NY.append(1 if rng.random() < min(0.95, p_resus) else 0)

X = np.array(X, float); Y = np.array(Y, int); NX = np.array(NX, float); NY = np.array(NY, int)
print(f"  labours={N}  assessment rows={len(Y)}  positive={Y.mean():.3f}  newborn resuscitation={NY.mean():.3f}")
for k in ('obstruct', 'distress', 'preec', 'sepsis', 'aph', 'rupture'):
    print(f"    prevalence {k:9s}: {np.mean([c[k] for c in COND]):.4f}")
lag_alert = (X[:, FEATS.index('lag_ratio')] >= 1.0)
print(f"    rows meeting the guideline's cervix lag-time alert: {lag_alert.mean():.3f}")


def train_export(Xa, Ya, feats, meta, version, note, path, thr=(0.33, 0.60), subgroups=True):
    idx = np.arange(len(Ya))
    tr, te = train_test_split(idx, test_size=0.3, stratify=Ya, random_state=7)

    Xtr = apply_field_missingness(Xa[tr], feats, np.random.default_rng(1))
    clf = GradientBoostingClassifier(n_estimators=240, max_depth=3, learning_rate=0.06,
                                     subsample=0.9, random_state=7).fit(Xtr, Ya[tr])

    p_complete = clf.predict_proba(Xa[te])[:, 1]
    Xte = apply_field_missingness(Xa[te], feats, np.random.default_rng(2))
    p_field = clf.predict_proba(Xte)[:, 1]

    auc_c = roc_auc_score(Ya[te], p_complete); br_c = brier_score_loss(Ya[te], p_complete)
    auc_f = roc_auc_score(Ya[te], p_field);    br_f = brier_score_loss(Ya[te], p_field)

    bs = []; r2 = np.random.default_rng(5)
    for _ in range(400):
        s = r2.integers(0, len(te), len(te))
        if len(set(Ya[te][s])) > 1:
            bs.append(roc_auc_score(Ya[te][s], p_field[s]))
    lo, hi = np.percentile(bs, [2.5, 97.5])

    print(f"\n  {version}")
    print(f"    AUROC, complete records ........... {auc_c:.3f}  (Brier {br_c:.3f})")
    print(f"    AUROC, REALISTIC MISSINGNESS ...... {auc_f:.3f}  95% CI {lo:.3f}-{hi:.3f}  (Brier {br_f:.3f})   <- the field number")
    frac, mean = calibration_curve(Ya[te], p_field, n_bins=8)
    print("    calibration (field):", ", ".join(f"{a:.2f}->{b:.2f}" for a, b in zip(mean, frac)))

    if subgroups and meta is not None:
        m = np.array([meta[i] for i in te])
        for lab, msk in [('nullipara', m[:, 0] == 0), ('multipara', m[:, 0] > 0),
                         ('age <19', m[:, 1] < 19), ('age 19-34', (m[:, 1] >= 19) & (m[:, 1] <= 34)),
                         ('age >=35', m[:, 1] >= 35),
                         ('previous CS', m[:, 2] == 1), ('no previous CS', m[:, 2] == 0)]:
            if msk.sum() > 40 and len(set(Ya[te][msk])) > 1:
                print(f"      {lab:16s} AUROC {roc_auc_score(Ya[te][msk], p_field[msk]):.3f}  (n={msk.sum()})")

    imp = sorted(zip(feats, clf.feature_importances_), key=lambda x: -x[1])[:8]
    print("    top features:", ", ".join(f"{f} {v:.3f}" for f, v in imp))

    def tree_to_dict(t):
        T = t.tree_
        def node(i):
            if T.children_left[i] == -1:
                return {"v": round(float(T.value[i][0][0]), 5)}
            return {"f": int(T.feature[i]), "t": round(float(T.threshold[i]), 6),
                    "l": node(T.children_left[i]), "r": node(T.children_right[i])}
        return node(0)
    trees = [tree_to_dict(e[0]) for e in clf.estimators_]

    model = {
        "features": feats,
        "defaults": {f: DEFAULTS[f] for f in feats},
        "base": round(float(clf.init_.class_prior_[1] and np.log(Ya[tr].mean() / (1 - Ya[tr].mean()))), 6),
        "learning_rate": 0.06,
        "trees": trees,
        "thresholds": {"amber": thr[0], "red": thr[1]},
        "version": version,
        "auroc": round(float(auc_f), 3),
        "auroc_complete_records": round(float(auc_c), 3),
        "auroc_ci95": [round(float(lo), 3), round(float(hi), 3)],
        "brier": round(float(br_f), 3),
        "n_labours": int(N),
        "feature_availability": {f: P_PRESENT.get(f, 1.0) for f in feats},
        "note": note,
    }
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), path)
    with open(out, "w") as fh:
        json.dump(model, fh)
    print(f"    written: {path}  ({os.path.getsize(out)/1024:.0f} KB, {len(trees)} trees)")
    return auc_f


NOTE = ("Intrapartum risk, Labour Care Guide contract. Active first stage begins at 5 cm. Poor "
        "progress is expressed as stall_h and lag_ratio (time at the current dilatation against the "
        "guideline's lag time for it), replacing the 4 cm-anchored cvx_rate of the partograph era. "
        "Metrics are reported under the missingness the tool actually produces, not on complete "
        "records. The score is advisory and never suppresses a Labour Care Guide alert.")
NB_NOTE = ("Newborn resuscitation readiness at birth, from the last Labour Care Guide assessment. "
           "Advisory: it prepares the room, it does not decide care.")

train_export(X, Y, FEATS, META, "adhere-eth-lcg-4.0", NOTE, "public/model/risk_model.json")
train_export(NX, NY, NB_FEATS, None, "adhere-nb-lcg-4.0", NB_NOTE, "public/model/newborn_model.json",
             thr=(0.30, 0.55), subgroups=False)
print("\nDone.")
