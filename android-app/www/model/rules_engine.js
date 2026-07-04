/* Module 2 — deterministic guideline-adherence engine.
   Evaluates recorded encounter fields against the rule set; returns unmet-step prompts
   and an adherence score. Real-time, transparent, no ML. */
(function(global){
  function applicable(rule, enc){
    var w=rule.when||{};
    if(w.encounter && enc.encounter!==w.encounter) return false;
    if(w.cervix_ge!==undefined && !(+enc.cervix_cm>=w.cervix_ge)) return false;
    if(w.past_action_line!==undefined && !enc.past_action_line) return false;
    return true;
  }
  function RulesEngine(ruleset){ this.rules=ruleset.rules||ruleset; }
  RulesEngine.prototype.evaluate = function(enc){
    var appl=this.rules.filter(r=>applicable(r,enc));
    var unmet=appl.filter(r=>!enc[r.require]);
    var met=appl.length-unmet.length;
    return { applicable:appl.length, met:met,
             adherence: appl.length? met/appl.length : 1,
             prompts: unmet.map(r=>({id:r.id,msg:r.msg,sev:r.sev})) };
  };
  global.RulesEngine = RulesEngine;
})(typeof window!=='undefined'?window:global);
if(typeof module!=='undefined') module.exports=(typeof window!=='undefined'?window:global).RulesEngine;
