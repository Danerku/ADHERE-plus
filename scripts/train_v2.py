"""
ADHERE+ intrapartum + newborn risk models — expanded clinically-grounded cohort.
Larger cohort than v1 (6,000 labours), same mechanism-based generation calibrated to
Ethiopia/SSA facility prevalences. Trains: (1) maternal intrapartum-complication model,
(2) newborn-resuscitation-need model. Exports compact JSON for on-device JS inference.
"""
import numpy as np, json, os
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, brier_score_loss, confusion_matrix
from sklearn.calibration import calibration_curve

rng = np.random.default_rng(11)
N = 6000

def draw_woman():
    age = int(np.clip(rng.normal(25, 6), 14, 46))
    parity = int(np.clip(rng.poisson(1.6), 0, 9))
    ga = float(np.clip(rng.normal(39, 1.6), 32, 43))
    prior_cs = 1 if (parity > 0 and rng.random() < 0.10) else 0
    chronic_htn = 1 if rng.random() < 0.05 else 0
    short_stat = 1 if rng.random() < 0.15 else 0
    rom_hours = float(max(0, rng.exponential(4)))
    p_obstruct = 0.072 + 0.06*(parity==0) + 0.05*short_stat + 0.05*(ga>=41) + 0.06*prior_cs
    p_distress = 0.070 + 0.05*(ga>=41) + 0.04*(ga<37) + 0.03*chronic_htn
    p_preec    = 0.105 + 0.05*(parity==0) + 0.06*chronic_htn + 0.03*(age<18) + 0.03*(age>=35)
    p_sepsis   = 0.042 + 0.10*(rom_hours>18) + 0.03*(ga<37)
    p_aph      = 0.027 + 0.02*prior_cs
    cond = {'obstruct': rng.random()<p_obstruct, 'distress': rng.random()<p_distress,
            'preec': rng.random()<p_preec, 'sepsis': rng.random()<p_sepsis, 'aph': rng.random()<p_aph}
    return dict(age=age, parity=parity, ga=ga, prior_cs=prior_cs, chronic_htn=chronic_htn,
                short_stat=short_stat, rom_hours=rom_hours, **cond)

def exam_rows(w):
    rows = []; n_ex = rng.integers(3, 7)
    complicated = w['obstruct'] or w['distress'] or w['preec'] or w['sepsis'] or w['aph']
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
        fhr = float(np.clip(fhr, 70, 210))
        meconium = 1 if (w['distress'] and rng.random()<0.4+0.4*stage) else (1 if rng.random()<0.04 else 0)
        sbp = rng.normal(118,10) + (25+15*stage)*w['preec'] + 12*w['chronic_htn']
        dbp = rng.normal(76,8)   + (15+10*stage)*w['preec'] + 8*w['chronic_htn']
        sbp,dbp = float(np.clip(sbp,90,220)), float(np.clip(dbp,55,140))
        urine_prot = int(np.clip(rng.poisson(0.1 + 2.2*w['preec']*stage), 0, 4))
        headache = 1 if (w['preec'] and rng.random()<0.2+0.4*stage) else 0
        blurred  = 1 if (w['preec'] and rng.random()<0.15+0.35*stage) else 0
        epigastric = 1 if (w['preec'] and rng.random()<0.1+0.3*stage) else 0
        clonus = 1 if (w['preec'] and sbp>=160 and rng.random()<0.5) else 0
        temp = float(np.clip(rng.normal(37.0,0.3) + 1.6*w['sepsis']*stage, 35.5, 41))
        pulse = float(np.clip(rng.normal(84,8) + 22*w['sepsis']*stage + 10*w['aph'], 55, 160))
        bleeding = 1 if (w['aph'] and rng.random()<0.5+0.4*stage) else 0
        feats = dict(hrs=round(hrs,1), cvx=round(cvx,1), cvx_rate=round(cvx_rate,2), fhr=round(fhr),
                     ctx=ctx, mld=mld, meconium=meconium, sbp=round(sbp), dbp=round(dbp),
                     urine_prot=urine_prot, temp=round(temp,1), pulse=round(pulse), bleeding=bleeding,
                     headache=headache, blurred=blurred, epigastric=epigastric, clonus=clonus,
                     age=w['age'], parity=w['parity'], ga=round(w['ga'],1), prior_cs=w['prior_cs'],
                     rom_hours=round(w['rom_hours'],1))
        y = 1 if (complicated and rng.random()<0.35+0.6*stage) else (1 if (not complicated and rng.random()<0.03) else 0)
        rows.append((feats,y)); last=feats
    return rows, last

FEATS = ['hrs','cvx','cvx_rate','fhr','ctx','mld','meconium','sbp','dbp','urine_prot','temp','pulse',
         'bleeding','headache','blurred','epigastric','clonus','age','parity','ga','prior_cs','rom_hours']
NB_FEATS = ['ga','meconium','fhr','mld','cvx','hrs','ctx','sbp','temp','prior_cs','age','parity','rom_hours']

X=[]; Y=[]; META=[]; NX=[]; NY=[]; COND=[]; n_comp=0
for _ in range(N):
    w=draw_woman(); COND.append({k:w[k] for k in ['obstruct','distress','preec','sepsis','aph']})
    if any(w[k] for k in ['obstruct','distress','preec','sepsis','aph']): n_comp+=1
    rows,last=exam_rows(w)
    for feats,y in rows:
        X.append([feats[f] for f in FEATS]); Y.append(y); META.append((w['parity'],feats['sbp']))
    # newborn resuscitation-need label (per birth), from intrapartum picture + last exam
    p_resus = 0.05 + 0.34*w['distress'] + 0.14*w['obstruct'] + 0.12*w['sepsis'] + 0.20*(w['ga']<37) \
              + 0.10*w['aph'] + 0.10*last['meconium'] + 0.06*(last['fhr']<110 or last['fhr']>170)
    resus = 1 if rng.random() < min(0.92, p_resus) else 0
    NX.append([last[f] for f in NB_FEATS]); NY.append(resus)

X=np.array(X,float); Y=np.array(Y,int); NX=np.array(NX,float); NY=np.array(NY,int)
print(f"maternal rows={len(Y)} pos={Y.mean():.3f} | newborn births={len(NY)} resus_rate={NY.mean():.3f} | women={N}")
for k in ["obstruct","distress","preec","sepsis","aph"]:
    print(f"  prevalence {k}: {np.mean([c[k] for c in COND]):.3f}")

def train_export(X,Y,feats,meta,version,note,path,thr=(0.33,0.60)):
    if meta is not None:
        Xtr,Xte,ytr,yte,mtr,mte = train_test_split(X,Y,meta,test_size=0.3,stratify=Y,random_state=3)
    else:
        Xtr,Xte,ytr,yte = train_test_split(X,Y,test_size=0.3,stratify=Y,random_state=3); mte=None
    clf=GradientBoostingClassifier(n_estimators=220,max_depth=3,learning_rate=0.06,subsample=0.9,random_state=3).fit(Xtr,ytr)
    prob=clf.predict_proba(Xte)[:,1]; auc=roc_auc_score(yte,prob); brier=brier_score_loss(yte,prob)
    print(f"  {version}: AUROC={auc:.3f} Brier={brier:.3f}")
    if mte is not None:
        par=np.array([m[0] for m in mte])
        for lab,msk in [('nullipara',par==0),('multipara',par>0)]:
            if msk.sum()>20 and len(set(yte[msk]))>1:
                print(f"    subgroup {lab}: AUROC={roc_auc_score(yte[msk],prob[msk]):.3f} (n={msk.sum()})")
    frac,mean=calibration_curve(yte,prob,n_bins=8)
    print("    calibration:", [f"{a:.2f}->{b:.2f}" for a,b in zip(mean,frac)])
    def tree_to_dict(t):
        T=t.tree_
        def node(i):
            if T.children_left[i]==-1: return {"v":round(float(T.value[i][0][0]),5)}
            return {"f":int(T.feature[i]),"t":round(float(T.threshold[i]),6),"l":node(T.children_left[i]),"r":node(T.children_right[i])}
        return node(0)
    trees=[tree_to_dict(e[0]) for e in clf.estimators_]
    def jse(node,x):
        while 'v' not in node: node=node['l'] if x[node['f']]<=node['t'] else node['r']
        return node['v']
    x0=list(Xtr[0]); base=float(clf.decision_function([x0])[0]) - float(clf.learning_rate)*sum(jse(t,x0) for t in trees)
    # parity of JS vs sklearn
    import numpy as _np
    diffs=[abs(1/(1+_np.exp(-(base+float(clf.learning_rate)*sum(jse(t,list(xr)) for t in trees)))) - p) for xr,p in zip(Xte[:200],prob[:200])]
    print(f"    JS-vs-sklearn max prob diff (n=200): {max(diffs):.2e}")
    model={"features":feats,"base":round(base,6),"learning_rate":float(clf.learning_rate),"trees":trees,
           "thresholds":{"amber":thr[0],"red":thr[1]},"version":version,
           "auroc":round(float(auc),3),"brier":round(float(brier),3),"n_labours":N,"note":note}
    json.dump(model,open(path,"w")); print(f"    exported {path} trees={len(trees)}")
    return auc

note_m=("Trained on a clinically-grounded simulated labour cohort (~%d labours) whose complication "
        "prevalences are calibrated to Ethiopia/SSA peer-reviewed meta-analyses. Clinical decision "
        "support only; retrain and revalidate on real de-identified records before clinical use." % N)
note_n=("Newborn resuscitation-need estimate from the intrapartum picture, trained on the same "
        "clinically-grounded simulated cohort. Decision support only; revalidate on real records.")
os.makedirs("/tmp/mout",exist_ok=True)
train_export(X,Y,FEATS,META,"adhere-eth-1.2",note_m,"/tmp/mout/risk_model.json")
train_export(NX,NY,NB_FEATS,None,"adhere-newborn-eth-1.0",note_n,"/tmp/mout/newborn_model.json",thr=(0.30,0.55))
print("DONE")
