// On-device inference for the exported gradient-boosted risk model (offline-capable).
(function(global){
  function evalTree(node, x){ while(!('v' in node)){ node = x[node.f] <= node.t ? node.l : node.r; } return node.v; }
  function sigmoid(z){ return 1/(1+Math.exp(-z)); }
  function RiskModel(model){
    this.m = model;
    this.index = {}; model.features.forEach((f,i)=>this.index[f]=i);
  }
  RiskModel.prototype.vector = function(obj){
    return this.m.features.map(f => { var v = obj[f]; return (v===undefined||v===null||v==='')?0:+v; });
  };
  RiskModel.prototype.predict = function(obj){
    var x = this.vector(obj);
    var raw = this.m.base;
    for(var i=0;i<this.m.trees.length;i++){ raw += this.m.learning_rate * evalTree(this.m.trees[i], x); }
    var p = sigmoid(raw);
    var band = p >= this.m.thresholds.red ? 'red' : (p >= this.m.thresholds.amber ? 'amber' : 'green');
    return { probability: p, band: band };
  };
  global.RiskModel = RiskModel;
})(typeof window!=='undefined'?window:global);
if (typeof module!=='undefined') module.exports = (typeof window!=='undefined'?window:global).RiskModel;
