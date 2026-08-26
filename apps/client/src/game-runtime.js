/* Aetherfall Arena: single-file 3D target-combat browser prototype.
   Original art/assets only. Three.js is loaded from CDN for rendering. */
(() => {
'use strict';
/* === AetherKit injected === */
/* ============================================================================
   AetherKit — drop-in rigged-model system for Aetherfall Arena.
   Loads the embedded Modular Character Outfits (.glb), and drives their
   Unreal-mannequin skeletons procedurally (idle / walk / attack / cast),
   since the source models ship with a rig but NO animation clips.

   TUNING: I cannot run WebGL in the build sandbox, so a few sign choices
   (which way a knee/elbow bends, which way arms raise to cast) are best-guess.
   If a limb bends the wrong way in play, flip the matching sign in RIG_T below.
   ========================================================================== */
const AetherKit=(()=>{
  // ---- which outfit each class wears (edit freely) -----------------------
  const MODEL_MAP={
    flame :'Female_Ranger',
    shadow:'Male_Ranger',
    storm :'Female_Ranger',
    wind  :'Male_Peasant',
    soul  :'Female_Peasant',
    sage  :'Female_Peasant',
    pala  :'Male_Ranger',
    disc  :'Female_Peasant',
    warrior:'Male_Ranger'
  };
  // ---- animation tuning. Flip a sign if a joint moves the wrong way -------
  const RIG_T={
    targetHeight : 1.95,  // world units, full height incl. head (was 2.30 — these read shorter)
    headRatio    : 0.86,  // Head joint sits at this fraction of total height (keeps proportions consistent)
    gearRefHeight: 2.00,  // body height the transmog art was authored for (gear is scaled to fit)
    classTint    : 0.30,  // how strongly the base outfit takes on the class colour (0 = none)
    classGlow    : 0.16,  // emissive class-colour accent on the outfit
    legSwing     : 0.62,  // hip swing amplitude while running
    armSwing     : 0.50,  // shoulder swing amplitude while running
    kneeBend     : 0.85,  // knee flex amplitude
    kneeSign     : +1,    // flip if knees bend forwards (hyper-extend)
    elbowBend    : 0.30,  // resting elbow flex
    elbowSign    : +1,    // flip if elbows bend the wrong way
    spineTwist   : 0.12,  // counter-rotation of torso vs legs
    bob          : 0.055, // vertical body bob while running
    breathe      : 0.035, // idle breathing amplitude
    sway         : 0.040, // idle arm sway
    castRaise    : 1.05,  // how far arms come up to cast
    castSign     : -1,    // flip if casting arms swing backwards
    meleeWind    : 0.45,  // melee wind-up
    meleeSwing   : 1.75,  // melee follow-through
    meleeSign    : -1,    // flip if the melee arm swings backwards
    // arms ship in a T-pose (straight out sideways); bring them down to the body first
    armDown      : 1.30,  // radians to lower arms from T-pose (~75 deg). 1.57 = straight down
    armDownSign  : +1,    // flip if arms fold UP/backwards instead of down
    armSwingSign : +1,    // flip if arms swing out of phase with the stride
    // procedural head (the outfit models ship with no head geometry)
    headScale    : 0.058, // head radius as a fraction of body height
    headRise     : 0.50,  // how far the head sits above the Head-bone joint (× radius)
    skin         : 0xcaa07a, // head/face tone
    hair         : 0x3a2a1a   // simple hair-cap tone (skipped when a hood is present)
  };

  const SWING_BONES=['thigh_l','thigh_r','calf_l','calf_r',
                     'upperarm_l','upperarm_r','lowerarm_l','lowerarm_r',
                     'spine_01','spine_02','spine_03','neck_01','Head','pelvis',
                     'clavicle_l','clavicle_r','hand_l','hand_r'];

  const sources={};   // key -> { scene, meta, scale, footY, yawFix }
  // Identical class outfits can share their immutable base materials. This keeps
  // the complete model and textures while letting Three group consecutive draws
  // by material and avoids creating another material graph for every combatant.
  const tintedMaterials=new Map();
  let   loaded=false;

  let _q=null, _q2=null, _qf=null;   // scratch; created lazily once THREE is ready (see loadAll)

  function b64ToArrayBuffer(dataUri){
    const b64=dataUri.split(',')[1];
    const bin=atob(b64); const len=bin.length; const bytes=new Uint8Array(len);
    for(let i=0;i<len;i++) bytes[i]=bin.charCodeAt(i);
    return bytes.buffer;
  }

  // Build the per-bone rig metadata from a freshly-loaded source scene.
  function buildMeta(scene){
    scene.updateMatrixWorld(true);
    const bones={};
    scene.traverse(o=>{ if(o.isBone) bones[o.name]=o; });
    const L=bones['thigh_l'], R=bones['thigh_r'];
    // lateral axis (left->right) in the model's world space
    let lateral=new THREE.Vector3(1,0,0);
    if(L&&R){ lateral=R.getWorldPosition(new THREE.Vector3())
                     .sub(L.getWorldPosition(new THREE.Vector3())); lateral.y=0; }
    if(lateral.lengthSq()<1e-6) lateral.set(1,0,0); lateral.normalize();
    const up=new THREE.Vector3(0,1,0);
    const forward=new THREE.Vector3().crossVectors(up,lateral).normalize(); // body facing
    const yawFix=-Math.atan2(forward.x,forward.z);                          // rotate so it faces +Z

    const meta={};
    SWING_BONES.forEach(name=>{
      const b=bones[name]; if(!b) return;
      const invParent=new THREE.Quaternion();
      if(b.parent) b.parent.getWorldQuaternion(invParent).invert();
      meta[name]={
        rest : b.quaternion.clone(),
        lat  : lateral.clone().applyQuaternion(invParent).normalize(),  // swing axis in parent space
        up   : up.clone().applyQuaternion(invParent).normalize(),       // twist axis in parent space
        fwd  : forward.clone().applyQuaternion(invParent).normalize()   // body-facing axis in parent space
      };
    });

    // scale + foot offset. Base the scale on the Head joint (not the raw bounding box)
    // so hooded and bare-headed models end up the same height with matching proportions.
    const box=new THREE.Box3().setFromObject(scene);
    const footMin=box.min.y;
    const headB=bones['Head'];
    let scale;
    if(headB){
      const headY=headB.getWorldPosition(new THREE.Vector3()).y;
      const bodyToHead=Math.max(0.001, headY-footMin);
      scale=(RIG_T.targetHeight*RIG_T.headRatio)/bodyToHead;
    } else {
      const h=Math.max(0.001, box.max.y-footMin);
      scale=RIG_T.targetHeight/h;
    }
    const footY=-footMin*scale;
    return {meta, scale, footY, yawFix};
  }

  function loadOne(key){
    return new Promise((resolve,reject)=>{
      const data=window.AETHER_MODEL_DATA && window.AETHER_MODEL_DATA[key];
      if(!data){ reject(new Error('missing model '+key)); return; }
      const loader=new window.GLTFLoader();
      // data is an embedded-glTF JSON string (textures are inline data URIs -> no blob URLs)
      const payload=(typeof data==='string'&&data.charCodeAt(0)===123)?data:b64ToArrayBuffer(data);
      loader.parse(payload,'',gltf=>{
        const scene=gltf.scene;
        const info=buildMeta(scene);
        sources[key]={scene, ...info};
        resolve();
      }, reject);
    });
  }

  async function loadAll(){
    if(loaded) return;
    if(!_q){ _q=new THREE.Quaternion(); _q2=new THREE.Quaternion(); _qf=new THREE.Quaternion(); }
    const keys=[...new Set(Object.values(MODEL_MAP))];
    await Promise.all(keys.map(loadOne));
    loaded=true;
  }

  // Apply rotation(s) to one bone: quaternion = (twist*lateral) * rest
  function setBone(rig,name,latAngle,upAngle){
    const b=rig.bones[name]; if(!b) return;
    const m=rig.meta[name];  if(!m) return;
    b.quaternion.copy(m.rest);
    if(latAngle){ _q.setFromAxisAngle(m.lat, latAngle); b.quaternion.premultiply(_q); }
    if(upAngle){  _q2.setFromAxisAngle(m.up,  upAngle ); b.quaternion.premultiply(_q2); }
  }

  // Sign to bring each arm down from the T-pose (rotate around the forward axis).
  const ARM_SIDE={l:-1, r:+1};

  // Pose one upper arm: lower it to the body (around fwd), then swing it fwd/back (around lat).
  function armPose(rig, side, swing, extraDown){
    const b=rig.bones['upperarm_'+side]; if(!b) return;
    const me=rig.meta['upperarm_'+side]; if(!me) return;
    b.quaternion.copy(me.rest);
    const down=(RIG_T.armDown+(extraDown||0))*ARM_SIDE[side]*RIG_T.armDownSign;
    if(down){ _qf.setFromAxisAngle(me.fwd, down); b.quaternion.premultiply(_qf); }
    if(swing){ _q.setFromAxisAngle(me.lat, swing*RIG_T.armSwingSign); b.quaternion.premultiply(_q); }
  }

  // The outfit models ship with NO head geometry, so build a simple one and
  // parent it to the Head bone (it then follows the skeleton like everything else).
  function attachHead(wrapper, model, bones, hooded){
    const headBone=bones['Head']; if(!headBone) return;
    wrapper.updateMatrixWorld(true);
    const pHead=headBone.getWorldPosition(new THREE.Vector3());
    const bodyUp=new THREE.Vector3(0,1,0);
    const rWorld=RIG_T.targetHeight*RIG_T.headScale;     // desired world-space radius

    const grp=new THREE.Group();
    const skinCol=hooded?0x6b5a45:RIG_T.skin;            // shadowed face under a hood
    const head=new THREE.Mesh(new THREE.SphereGeometry(1,16,12),
                 new THREE.MeshStandardMaterial({color:skinCol,roughness:0.85,metalness:0.0}));
    head.scale.set(1,1.15,1.02);
    grp.add(head);
    if(!hooded){
      const hair=new THREE.Mesh(
        new THREE.SphereGeometry(1.07,16,12,0,Math.PI*2,0,Math.PI*0.6),
        new THREE.MeshStandardMaterial({color:RIG_T.hair,roughness:0.95,metalness:0.0}));
      hair.position.y=0.12;
      grp.add(hair);
    }
    // Larger, warmer stylised facial features so the character reads naturally in-game.
    const eyeWhite=new THREE.MeshStandardMaterial({color:0xfff9ec,roughness:.34});
    const iris=new THREE.MeshStandardMaterial({color:hooded?0x9df4ff:0x427da6,emissive:hooded?0x54dff1:0x000000,emissiveIntensity:hooded?.58:0,roughness:.25});
    const pupil=new THREE.MeshBasicMaterial({color:0x101720});
    const feature=new THREE.MeshStandardMaterial({color:hooded?0x765644:0xd09270,roughness:.78});
    const lipMat=new THREE.MeshStandardMaterial({color:0x743a40,roughness:.68});
    const cheekMat=new THREE.MeshStandardMaterial({color:0xe6a07f,transparent:true,opacity:.34,roughness:.9});
    [-.34,.34].forEach(x=>{
      const socket=new THREE.Mesh(new THREE.SphereGeometry(.235,11,8),eyeWhite);socket.scale.set(1,.72,.42);socket.position.set(x,.19,1.012);grp.add(socket);
      const colour=new THREE.Mesh(new THREE.SphereGeometry(.125,10,7),iris);colour.scale.z=.48;colour.position.set(x,.19,1.183);grp.add(colour);
      const dot=new THREE.Mesh(new THREE.SphereGeometry(.055,8,6),pupil);dot.scale.z=.36;dot.position.set(x,.19,1.246);grp.add(dot);
      const shine=new THREE.Mesh(new THREE.SphereGeometry(.021,6,5),new THREE.MeshBasicMaterial({color:0xffffff}));shine.position.set(x-.027,.225,1.271);grp.add(shine);
      const brow=new THREE.Mesh(new THREE.BoxGeometry(.33,.045,.036),new THREE.MeshStandardMaterial({color:RIG_T.hair,roughness:.9}));brow.position.set(x,.47,1.09);brow.rotation.z=x<0?-.07:.07;grp.add(brow);
      const cheek=new THREE.Mesh(new THREE.SphereGeometry(.095,7,5),cheekMat);cheek.scale.set(1,.48,.18);cheek.position.set(x*.93,-.19,1.105);grp.add(cheek);
    });
    const noseBridge=new THREE.Mesh(new THREE.ConeGeometry(.11,.285,8),feature);noseBridge.rotation.x=Math.PI/2;noseBridge.position.set(0,-.035,1.16);grp.add(noseBridge);
    const noseTip=new THREE.Mesh(new THREE.SphereGeometry(.09,8,6),feature);noseTip.scale.set(1,.78,.5);noseTip.position.set(0,-.085,1.275);grp.add(noseTip);
    const mouth=new THREE.Mesh(new THREE.BoxGeometry(.39,.052,.043),lipMat);mouth.position.set(0,-.37,1.122);grp.add(mouth);
    [-1,1].forEach(side=>{const smile=new THREE.Mesh(new THREE.BoxGeometry(.10,.04,.04),lipMat);smile.position.set(side*.19,-.345,1.121);smile.rotation.z=side*.34;grp.add(smile);});
    grp.traverse(o=>{ o.castShadow=false; o.receiveShadow=false; o.frustumCulled=false; });

    headBone.add(grp);
    // orient the head to world-up at rest (so it sits upright), then it rides the bone
    grp.quaternion.copy(headBone.getWorldQuaternion(new THREE.Quaternion())).invert();
    // place its centre just above the head joint, in bone-local space
    const centerWorld=pHead.clone().addScaledVector(bodyUp, rWorld*RIG_T.headRise);
    grp.position.copy(headBone.worldToLocal(centerWorld.clone()));
    // size: convert desired world radius into bone-local units (cancel the rig scale)
    const sc=new THREE.Vector3();
    headBone.matrixWorld.decompose(new THREE.Vector3(),new THREE.Quaternion(),sc);
    grp.scale.multiplyScalar(rWorld/Math.max(1e-4,(sc.x+sc.y+sc.z)/3));
  }

  // AetherKit class identity weapons: lightweight procedural props attached to the imported rig.
  // They intentionally do not use the transmog mesh system; gear stats remain separate from appearance.
  function attachClassWeapons(wrapper,bones,cls,modelScale){
    const right=bones['hand_r'],left=bones['hand_l'];
    if(!right) return;
    const invScale=1/Math.max(.001,modelScale||1);
    const classColour=(typeof CLASS_INFO!=='undefined'&&CLASS_INFO[cls])?CLASS_INFO[cls].colour:0xffdc78;
    const glow=new THREE.MeshStandardMaterial({color:classColour,emissive:classColour,emissiveIntensity:.9,metalness:.25,roughness:.25});
    const metal=new THREE.MeshStandardMaterial({color:0xcbd4df,emissive:classColour,emissiveIntensity:.22,metalness:.82,roughness:.25});
    const dark=new THREE.MeshStandardMaterial({color:0x2b2526,metalness:.44,roughness:.42});
    const wood=new THREE.MeshStandardMaterial({color:0x4b3020,emissive:classColour,emissiveIntensity:.10,roughness:.7});
    const orbMat=new THREE.MeshStandardMaterial({color:0xeefcff,emissive:classColour,emissiveIntensity:1.3,transparent:true,opacity:.94,roughness:.18});
    // The weapon meshes are authored lengthwise on their local +Y axis. Do not rely on a small
    // hand rotation offset: the imported hand bone itself inherits a broad rig/T-pose orientation.
    // Aim that +Y weapon axis directly into a combat-ready forward vector in character space.
    // This makes the change visibly obvious on the model and keeps swing/cast animation on top.
    const forwardGrip={
      warrior:{dir:[ .11,-.20, 1.00],roll:.10}, // axe driven forward, slightly downward
      pala:   {dir:[ .09,-.25, 1.00],roll:.07}, // sword point forward/down
      shadow: {dir:[ .18,-.16, 1.00],roll:.18}, // reverse fighting knives
      wind:   {dir:[ .08, .26, 1.00],roll:.05}, // quarterstaff angled forward/up
      flame:  {dir:[ .08, .08, 1.00],roll:.06}, // wand points at target
      storm:  {dir:[ .07, .34, 1.00],roll:.04}, // staff focus aimed ahead
      soul:   {dir:[ .10, .27, 1.00],roll:.08}, // scythe held on forward diagonal
      sage:   {dir:[ .06, .36, 1.00],roll:.04}  // nature staff presentation
    }[cls]||{dir:[0,.12,1],roll:0};
    const weaponAxis=new THREE.Vector3(0,1,0);
    const prop=(hand)=>{
      const g=new THREE.Group();
      g.scale.setScalar(invScale);
      hand.add(g);
      wrapper.updateMatrixWorld(true);
      const mirror=hand===left?-1:1;
      const desiredDir=new THREE.Vector3(forwardGrip.dir[0]*mirror,forwardGrip.dir[1],forwardGrip.dir[2]).normalize();
      const aim=new THREE.Quaternion().setFromUnitVectors(weaponAxis,desiredDir);
      const roll=new THREE.Quaternion().setFromAxisAngle(desiredDir,forwardGrip.roll*mirror);
      const desiredWorld=roll.multiply(aim);
      // Cancel the imported hand-bone world rotation, then impose the deliberate forward-facing grip.
      g.quaternion.copy(hand.getWorldQuaternion(new THREE.Quaternion())).invert().multiply(desiredWorld);
      g.userData.classWeapon=true;
      g.userData.restQuat=g.quaternion.clone();
      g.userData.restPos=g.position.clone();
      wrapper.userData.weaponRoots=(wrapper.userData.weaponRoots||[]);
      wrapper.userData.weaponRoots.push(g);
      return g;
    };
    const add=(g,m)=>{m.castShadow=false;m.receiveShadow=false;m.frustumCulled=false;g.add(m);return m;};
    const grip=(g,len=.22)=>{const h=add(g,new THREE.Mesh(new THREE.CylinderGeometry(.035,.035,len,7),dark));h.position.y=len*.3;return h;};
    const pulse=(g,parts=[])=>{g.userData.weaponGlowParts=parts;wrapper.userData.weaponGlowParts=(wrapper.userData.weaponGlowParts||[]).concat(parts);};
    const r=prop(right);
    if(cls==='warrior'){
      grip(r,.32);const shaft=add(r,new THREE.Mesh(new THREE.CylinderGeometry(.035,.045,1.04,8),wood));shaft.position.y=.33;
      const head=add(r,new THREE.Mesh(new THREE.BoxGeometry(.55,.18,.12),metal));head.position.y=.86;
      const edge=add(r,new THREE.Mesh(new THREE.ConeGeometry(.20,.34,5),glow));edge.rotation.z=-Math.PI/2;edge.position.set(.29,.85,0);pulse(r,[edge]);
    }else if(cls==='pala'){
      grip(r,.27);const blade=add(r,new THREE.Mesh(new THREE.BoxGeometry(.095,.92,.045),metal));blade.position.y=.58;
      const tip=add(r,new THREE.Mesh(new THREE.ConeGeometry(.065,.16,5),glow));tip.position.y=1.12;
      const guard=add(r,new THREE.Mesh(new THREE.BoxGeometry(.34,.045,.065),glow));guard.position.y=.16;pulse(r,[tip,guard]);
      if(left){const l=prop(left);const shield=add(l,new THREE.Mesh(new THREE.CylinderGeometry(.29,.29,.065,8),glow));shield.rotation.x=Math.PI/2;shield.position.set(0,.18,0);pulse(l,[shield]);}
    }else if(cls==='shadow'){
      const blade=add(r,new THREE.Mesh(new THREE.ConeGeometry(.065,.56,4),metal));blade.position.y=.42;const rune=add(r,new THREE.Mesh(new THREE.TorusGeometry(.09,.015,6,12),glow));rune.position.y=.20;rune.rotation.x=Math.PI/2;pulse(r,[rune]);
      if(left){const l=prop(left);const blade2=add(l,new THREE.Mesh(new THREE.ConeGeometry(.065,.56,4),metal));blade2.position.y=.42;const rune2=add(l,new THREE.Mesh(new THREE.TorusGeometry(.09,.015,6,12),glow));rune2.position.y=.20;rune2.rotation.x=Math.PI/2;pulse(l,[rune2]);}
    }else if(cls==='wind'){
      const staff=add(r,new THREE.Mesh(new THREE.CylinderGeometry(.032,.038,1.8,8),wood));staff.position.y=.15;const cap=add(r,new THREE.Mesh(new THREE.TorusGeometry(.12,.024,6,14),glow));cap.rotation.x=Math.PI/2;cap.position.y=1.0;pulse(r,[cap]);
    }else if(cls==='flame'){
      const wand=add(r,new THREE.Mesh(new THREE.CylinderGeometry(.028,.04,.76,7),wood));wand.position.y=.36;const crystal=add(r,new THREE.Mesh(new THREE.OctahedronGeometry(.13),orbMat));crystal.position.y=.84;pulse(r,[crystal]);
    }else if(cls==='storm'){
      const staff=add(r,new THREE.Mesh(new THREE.CylinderGeometry(.032,.045,1.55,8),dark));staff.position.y=.5;const fork1=add(r,new THREE.Mesh(new THREE.BoxGeometry(.035,.27,.035),glow));fork1.position.set(-.10,1.30,0);fork1.rotation.z=-.35;const fork2=fork1.clone();fork2.position.x=.10;fork2.rotation.z=.35;r.add(fork2);const core=add(r,new THREE.Mesh(new THREE.SphereGeometry(.095,10,8),orbMat));core.position.y=1.20;pulse(r,[fork1,fork2,core]);
    }else if(cls==='soul'){
      const pole=add(r,new THREE.Mesh(new THREE.CylinderGeometry(.028,.042,1.65,8),dark));pole.position.y=.52;const arc=add(r,new THREE.Mesh(new THREE.TorusGeometry(.28,.045,7,16,Math.PI),glow));arc.position.set(.17,1.25,0);arc.rotation.z=-Math.PI/2;const gem=add(r,new THREE.Mesh(new THREE.OctahedronGeometry(.10),orbMat));gem.position.y=1.18;pulse(r,[arc,gem]);
    }else if(cls==='sage'){
      const staff=add(r,new THREE.Mesh(new THREE.CylinderGeometry(.032,.046,1.62,8),wood));staff.position.y=.55;const blossom=add(r,new THREE.Mesh(new THREE.SphereGeometry(.12,10,8),orbMat));blossom.position.y=1.38;const ring=add(r,new THREE.Mesh(new THREE.TorusGeometry(.18,.022,8,16),glow));ring.position.y=1.38;ring.rotation.x=Math.PI/2;pulse(r,[blossom,ring]);
    }else if(cls==='disc'){
      grip(r,.30);
      const shaft=add(r,new THREE.Mesh(new THREE.CylinderGeometry(.038,.052,1.78,9),new THREE.MeshStandardMaterial({color:0xf0e8d0,metalness:.24,roughness:.32})));shaft.position.y=.62;
      const lowerCap=add(r,new THREE.Mesh(new THREE.ConeGeometry(.075,.22,8),metal));lowerCap.position.y=-.28;lowerCap.rotation.z=Math.PI;
      const headRing=add(r,new THREE.Mesh(new THREE.TorusGeometry(.27,.045,10,28),glow));headRing.position.y=1.46;headRing.rotation.x=Math.PI/2;
      const crescentL=add(r,new THREE.Mesh(new THREE.TorusGeometry(.31,.055,9,24,Math.PI*.82),glow));crescentL.position.set(-.17,1.47,0);crescentL.rotation.z=.22;
      const crescentR=add(r,new THREE.Mesh(new THREE.TorusGeometry(.31,.055,9,24,Math.PI*.82),glow));crescentR.position.set(.17,1.47,0);crescentR.rotation.z=Math.PI-.22;
      const starCore=add(r,new THREE.Mesh(new THREE.OctahedronGeometry(.16),orbMat));starCore.position.y=1.47;
      const crossV=add(r,new THREE.Mesh(new THREE.BoxGeometry(.055,.56,.055),glow));crossV.position.y=1.47;
      const crossH=add(r,new THREE.Mesh(new THREE.BoxGeometry(.52,.055,.055),glow));crossH.position.y=1.47;
      const ribbonMat=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.74,side:THREE.DoubleSide});
      const ribbonA=add(r,new THREE.Mesh(new THREE.PlaneGeometry(.14,.62),ribbonMat));ribbonA.position.set(-.12,1.02,.03);ribbonA.rotation.z=.18;
      const ribbonB=add(r,new THREE.Mesh(new THREE.PlaneGeometry(.14,.62),ribbonMat.clone()));ribbonB.position.set(.12,1.02,-.03);ribbonB.rotation.z=-.18;
      pulse(r,[headRing,crescentL,crescentR,starCore,crossV,crossH]);
    }
    // Weapon-led action readability: melee arcs travel with the weapon, while casters forge a spell at its focus.
    const spellFocus=new THREE.Group();
    spellFocus.position.set(0,cls==='flame'?.86:cls==='pala'?1.02:1.28,0);
    const spellCore=add(spellFocus,new THREE.Mesh(new THREE.SphereGeometry(.12,10,8),new THREE.MeshBasicMaterial({color:classColour,transparent:true,opacity:.94,depthWrite:false,blending:THREE.AdditiveBlending})));
    const spellRing=add(spellFocus,new THREE.Mesh(new THREE.TorusGeometry(.20,.025,7,18),new THREE.MeshBasicMaterial({color:classColour,transparent:true,opacity:.8,depthWrite:false,blending:THREE.AdditiveBlending})));spellRing.rotation.x=Math.PI/2;
    const spellRing2=spellRing.clone();spellRing2.scale.setScalar(1.34);spellRing2.rotation.y=Math.PI/2;spellFocus.add(spellRing2);
    spellFocus.visible=false;r.add(spellFocus);wrapper.userData.spellFocus=spellFocus;
    const weaponTrail=add(r,new THREE.Mesh(new THREE.TorusGeometry(.64,.055,7,34,Math.PI*1.22),new THREE.MeshBasicMaterial({color:classColour,transparent:true,opacity:0,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide})));
    weaponTrail.position.set(0,.67,0);weaponTrail.rotation.x=Math.PI/2;weaponTrail.visible=false;wrapper.userData.weaponTrail=weaponTrail;
  }

  // Build a wearable model group for a class. Returns a THREE.Group whose
  // userData.rig holds everything needed to animate it.
  function buildModelGroup(cls){
    const key=MODEL_MAP[cls]||'Male_Ranger';
    const src=sources[key];
    const wrapper=new THREE.Group();
    if(!src) return wrapper; // graceful: empty group if load failed

    const orient=new THREE.Group();              // faces +Z at wrapper.rotation.y===0
    orient.rotation.y=src.yawFix;
    orient.scale.setScalar(src.scale);
    const model=window.__skeletonClone(src.scene);

    // class colour for per-class theming (flame=fiery, storm=cyan, soul=violet, ...)
    let classCol=0xffffff;
    try{ if(typeof CLASS_INFO!=='undefined'&&CLASS_INFO[cls]) classCol=CLASS_INFO[cls].colour; }catch(e){}
    const tintCol=new THREE.Color(classCol);

    // Tint once per class/source material. Combat flashes no longer mutate model
    // materials, so sharing here is both visually identical and substantially
    // cheaper in a six-character match.
    model.traverse(o=>{
      if(o.isMesh){
        o.castShadow=false; o.receiveShadow=false; o.frustumCulled=false;
        const retint=m=>{
          const cacheKey=`${cls}:${m.uuid}`;
          if(tintedMaterials.has(cacheKey))return tintedMaterials.get(cacheKey);
          const c=m.clone();
          if(c.color&&RIG_T.classTint>0) c.color.lerp(tintCol, RIG_T.classTint);
          if(c.emissive){ c.emissive.copy(tintCol); c.emissiveIntensity=RIG_T.classGlow; }
          tintedMaterials.set(cacheKey,c);
          return c;
        };
        if(Array.isArray(o.material)) o.material=o.material.map(retint);
        else if(o.material) o.material=retint(o.material);
      }
    });

    orient.add(model);
    wrapper.add(orient);
    wrapper.position.y=src.footY;               // feet on the ground

    // collect this clone's bones
    const bones={};
    let hooded=false;
    model.traverse(o=>{ if(o.isBone) bones[o.name]=o;
                        if(o.isMesh&&/hood/i.test(o.name||'')) hooded=true; });

    attachHead(wrapper, model, bones, hooded);
    attachClassWeapons(wrapper, bones, cls, src.scale);

    wrapper.userData.rig={ bones, meta:src.meta, footY:src.footY,
                           weaponGlowParts:wrapper.userData.weaponGlowParts||[],
                           weaponRoots:wrapper.userData.weaponRoots||[], spellFocus:wrapper.userData.spellFocus||null, weaponTrail:wrapper.userData.weaponTrail||null,
                           phase:Math.random()*Math.PI*2 };
    return wrapper;
  }

  // Drive the skeleton. state: {motion,phase,time,cast,castFury,melee,meleeStrike,spell}
  function pose(rig,state,dt){
    if(!rig||!rig.bones) return;
    try{
      const t   = state.phase||0;
      const m   = Math.max(0,Math.min(1,state.motion||0));
      const time= state.time||0;
      const idle= 1-m;

      // ---------- locomotion (legs / arms swing) ----------
      const lS=RIG_T.legSwing*m, aS=RIG_T.armSwing*m;
      const legL= Math.sin(t)*lS,        legR= Math.sin(t+Math.PI)*lS;
      const kneeL=Math.max(0,-Math.sin(t))     *RIG_T.kneeBend*m*RIG_T.kneeSign;
      const kneeR=Math.max(0,-Math.sin(t+Math.PI))*RIG_T.kneeBend*m*RIG_T.kneeSign;
      let armL=-Math.sin(t)*aS, armR=-Math.sin(t+Math.PI)*aS;

      // ---------- idle (breathing + gentle sway) ----------
      const breathe=Math.sin(time*1.7)*RIG_T.breathe*idle;
      const sway   =Math.sin(time*1.3)*RIG_T.sway   *idle;
      armL+=sway; armR-=sway;

      // base poses
      setBone(rig,'thigh_l', legL,0);
      setBone(rig,'thigh_r', legR,0);
      setBone(rig,'calf_l',  kneeL,0);
      setBone(rig,'calf_r',  kneeR,0);
      setBone(rig,'spine_02', breathe + m*0.05, -Math.sin(t)*RIG_T.spineTwist*m);
      setBone(rig,'spine_03', breathe*0.6, 0);
      setBone(rig,'neck_01',  -breathe*0.4, 0);

      const elbow=RIG_T.elbowBend*RIG_T.elbowSign;

      if(state.spell){
        // both arms raised forward to channel
        const r=RIG_T.castRaise*RIG_T.castSign;
        const flutter=Math.sin(time*9)*0.08;
        armPose(rig,'l', r+flutter, -0.30);
        armPose(rig,'r', r-flutter, -0.30);
        setBone(rig,'lowerarm_l', elbow*1.6, 0);
        setBone(rig,'lowerarm_r', elbow*1.6, 0);
      } else if(state.castFury){
        // rapid alternating punches
        const p=Math.sin(time*34);
        armPose(rig,'l', RIG_T.castRaise*RIG_T.castSign*0.7 + p*0.5, -0.20);
        armPose(rig,'r', RIG_T.castRaise*RIG_T.castSign*0.7 - p*0.5, -0.20);
        setBone(rig,'lowerarm_l', elbow*2.0, 0);
        setBone(rig,'lowerarm_r', elbow*2.0, 0);
      } else if(state.melee!=null){
        // Wind-up -> follow-through. Slicing Winds alternates hands so its
        // three rapid strikes visibly travel left, right, left.
        const s=state.meleeStrike||0; // 0..1..0
        const ang=(RIG_T.meleeWind - (RIG_T.meleeWind+RIG_T.meleeSwing)*s)*RIG_T.meleeSign;
        const left=Number(state.meleeSide||1)<0;
        armPose(rig,left?'l':'r',ang,left ? .20 : -.20);
        setBone(rig,left?'lowerarm_l':'lowerarm_r',elbow+s*.6,0);
        armPose(rig,left?'r':'l',left?armR:armL);
        setBone(rig,left?'lowerarm_r':'lowerarm_l',elbow,0);
        setBone(rig,'spine_02',breathe+m*.05,(left?1:-1)*s*.25);
      } else {
        armPose(rig,'l', armL);
        armPose(rig,'r', armR);
        setBone(rig,'lowerarm_l', elbow, 0);
        setBone(rig,'lowerarm_r', elbow, 0);
      }
      if(state.mounted){
        // Saddle pose tuned from the visible model: opposite thigh-twist signs
        // open the knees outward around the saddle instead of crossing inward.
        setBone(rig,'pelvis', .035, 0);
        setBone(rig,'thigh_l', 1.02, .86);
        setBone(rig,'thigh_r', 1.02, -.86);
        setBone(rig,'calf_l', -1.34, .12);
        setBone(rig,'calf_r', -1.34, -.12);
        setBone(rig,'foot_l', .22, .08);
        setBone(rig,'foot_r', .22, -.08);
        setBone(rig,'spine_02', .06 + Math.sin(time*2.1)*.012, 0);
        setBone(rig,'spine_03', .028, 0);
        armPose(rig,'l', -.16, -.14);
        armPose(rig,'r', -.16, -.14);
        setBone(rig,'lowerarm_l', elbow*1.42, 0);
        setBone(rig,'lowerarm_r', elbow*1.42, 0);
      }
      const weaponRoots=rig.weaponRoots||[];
      weaponRoots.forEach(root=>{if(root.userData.restQuat)root.quaternion.copy(root.userData.restQuat);});
      if(state.melee!=null){
        const slash=state.meleeStrike||0;
        weaponRoots.forEach((root,i)=>{const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(-.34*slash,(i?-.28:.28)*slash,-1.08*slash*(i?-.75:1)));root.quaternion.multiply(q);});
      }else if(state.spell){
        weaponRoots.forEach((root,i)=>{const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(.12*Math.sin(time*7+i),0,.18*Math.sin(time*4+i)));root.quaternion.multiply(q);});
      }
      if(rig.weaponTrail){const active=state.melee!=null;rig.weaponTrail.visible=active;rig.weaponTrail.material.opacity=active?.18+.68*(state.meleeStrike||0):0;rig.weaponTrail.scale.setScalar(1+(state.meleeStrike||0)*.4);rig.weaponTrail.rotation.z=-.7*(state.meleeStrike||0);}
      if(rig.spellFocus){rig.spellFocus.visible=!!state.spell;if(state.spell){const forge=.86+.34*Math.sin(time*10);rig.spellFocus.scale.setScalar(forge);rig.spellFocus.rotation.y+=dt*4.4;rig.spellFocus.children.forEach((p,i)=>{if(p.material)p.material.opacity=.52+.34*Math.sin(time*8+i);});}}
      const weaponParts=rig.weaponGlowParts||[];
      weaponParts.forEach((part,i)=>{if(part.material&&part.material.emissiveIntensity!==undefined)part.material.emissiveIntensity=.76+.48*Math.sin(time*4.7+i*.8)+(state.melee!=null||state.spell ? .44 : 0);});
      if(rig.weaponIllusion&&rig.weaponIllusion.tick)rig.weaponIllusion.tick(time,dt,state);
    }catch(e){ /* never let animation crash the frame */ }
  }

  return { MODEL_MAP, RIG_T, loadAll, buildModelGroup, pose,
           get ready(){return loaded;} };
})();

/* === end AetherKit === */
// Cosmetic prestige replaces missing transmog silhouettes while modular outfits are active.
// It is earned from equipped item quality or class rating, and never changes combat stats.
function prestigeVisualTier(cls,items=[]){
  const rating=Math.max(classRating(cls,'2v2'),classRating(cls,'3v3'));
  const topItem=(items||[]).reduce((m,item)=>Math.max(m,Number(item&&item.ilvl)||0),0);
  let tier=0;
  if(rating>=1700||topItem>=910)tier=1;
  if(rating>=1800||topItem>=920)tier=2;
  if(rating>=2000||topItem>=935)tier=3;
  if(rating>=2200||topItem>=950)tier=4;
  return {tier,rating,topItem};
}
function hasShadowmoon(items=[]){return (items||[]).some(item=>item?.legendaryId==='shadowmoon');}
function buildShadowmoonAura(){
  const g=new THREE.Group();g.userData.shadowmoon=true;
  const violet=new THREE.MeshBasicMaterial({color:0xb044ff,transparent:true,opacity:.72,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide});
  const hotViolet=new THREE.MeshBasicMaterial({color:0xf18cff,transparent:true,opacity:.64,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide});
  const darkViolet=new THREE.MeshBasicMaterial({color:0x6412b8,transparent:true,opacity:.46,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide});
  const inner=new THREE.Mesh(new THREE.TorusGeometry(.83,.066,8,48),violet);inner.rotation.x=Math.PI/2;inner.position.y=.06;g.add(inner);
  const pulse=new THREE.Mesh(new THREE.TorusGeometry(1.01,.045,8,52),hotViolet);pulse.rotation.x=Math.PI/2;pulse.position.y=.075;g.add(pulse);
  const outer=new THREE.Mesh(new THREE.TorusGeometry(1.29,.036,8,56),darkViolet);outer.rotation.x=Math.PI/2;outer.position.y=.09;g.add(outer);
  const disc=new THREE.Mesh(new THREE.RingGeometry(.48,1.25,52),darkViolet.clone());disc.rotation.x=-Math.PI/2;disc.position.y=.025;disc.material.opacity=.27;g.add(disc);
  // Curved wisps keep the aura visible without the old faceted cone or
  // floating diamond polygons obscuring the character model.
  const wisps=[];for(let i=0;i<7;i++){const w=new THREE.Mesh(new THREE.TorusGeometry(.20+i*.014,.024,8,24,Math.PI*1.38),i%3===0?hotViolet.clone():violet.clone());w.rotation.x=Math.PI/2;g.add(w);wisps.push(w);}
  g.userData.tick=dt=>{const t=performance.now()*.001;inner.rotation.z+=dt*1.28;pulse.rotation.z-=dt*.92;outer.rotation.z-=dt*.62;inner.material.opacity=.58+.22*Math.sin(t*4);pulse.material.opacity=.42+.22*Math.sin(t*3.4+1);outer.material.opacity=.34+.15*Math.sin(t*2.7+1);disc.material.opacity=.20+.10*Math.sin(t*2.2);disc.rotation.z-=dt*.38;wisps.forEach((w,i)=>{const a=t*(1.18+i*.045)+i*.90,r=.66+(i%3)*.21;w.position.set(Math.cos(a)*r,.10+.10*Math.sin(t*2+i),Math.sin(a)*r);w.rotation.z=a+i;w.material.opacity=.22+.20*Math.sin(t*3+i);});};
  return g;
}
function buildPrestigeVisual(cls,items=[]){
  if(hasShadowmoon(items))return buildShadowmoonAura();
  const earned=prestigeVisualTier(cls,items); if(!earned.tier)return null;
  const colours=[0x7dc5ff,0xb388ff,0xffb866,0xe4beff],col=colours[earned.tier-1];
  const g=new THREE.Group(); g.userData.prestigeTier=earned.tier;
  const ringMat=new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.42,side:THREE.DoubleSide});
  const inner=new THREE.Mesh(new THREE.RingGeometry(.93,1.02,40),ringMat);inner.rotation.x=-Math.PI/2;inner.position.y=.045;g.add(inner);
  const outer=earned.tier>=2?new THREE.Mesh(new THREE.RingGeometry(1.12,1.18,48),ringMat.clone()):null;
  if(outer){outer.material.opacity=.25;outer.rotation.x=-Math.PI/2;outer.position.y=.055;g.add(outer);}
  const motes=[]; const count=earned.tier>=4?6:earned.tier>=3?4:earned.tier>=2?2:0;
  for(let i=0;i<count;i++){const mote=new THREE.Mesh(new THREE.OctahedronGeometry(earned.tier>=4?.07:.055),new THREE.MeshStandardMaterial({color:col,emissive:col,emissiveIntensity:1.15,transparent:true,opacity:.9}));g.add(mote);motes.push(mote);}
  const crown=earned.tier>=3&&cls!=='disc'?new THREE.Mesh(new THREE.TorusGeometry(.36,.024,8,24),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:earned.tier>=4?.72:.47})):null;
  if(crown){crown.rotation.x=Math.PI/2;crown.position.y=2.54;g.add(crown);}
  g.userData.tick=(dt)=>{
    const t=performance.now()*.001;
    inner.material.opacity=.28+.16*Math.sin(t*3.2);inner.rotation.z+=dt*(earned.tier>=3?.72:.38);
    if(outer){outer.material.opacity=.18+.1*Math.sin(t*2.1+1);outer.rotation.z-=dt*.28;}
    motes.forEach((m,i)=>{const a=t*(.9+earned.tier*.08)+i*Math.PI*2/Math.max(1,count);const rad=earned.tier>=4?1.02:.9;m.position.set(Math.cos(a)*rad,.75+.25*Math.sin(t*2+i),Math.sin(a)*rad);m.rotation.y+=dt*2.3;});
    if(crown){crown.rotation.z+=dt*.38;crown.material.opacity=(earned.tier>=4?.56:.36)+.15*Math.sin(t*2.7);}
  };
  return g;
}
// The highest prestige tier earns a true weapon illusion: broad additive glow, drifting embers and a charged light.
// This remains cosmetic-only and therefore works while modular-model transmog silhouettes are disabled.
function applyPrestigeWeaponIllusion(modelGroup,cls,items=[]){
  if(hasShadowmoon(items))return;
  const rig=modelGroup&&modelGroup.userData&&modelGroup.userData.rig, earned=prestigeVisualTier(cls,items);
  if(!rig||earned.tier<4||rig.weaponIllusion)return;
  const base=(CLASS_INFO[cls]&&CLASS_INFO[cls].colour)||0xffd36f;
  const colour=cls==='warrior'?0xff1748:cls==='flame'?0xff421f:cls==='soul'?0xc14dff:base;
  const halos=[],wisps=[],motes=[];
  const makeMat=(opacity)=>new THREE.MeshBasicMaterial({color:colour,transparent:true,opacity,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide});
  (rig.weaponGlowParts||[]).forEach((part,i)=>{
    if(part.material&&part.material.emissiveIntensity!==undefined)part.material.emissiveIntensity=2.8;
    if(part.geometry){const halo=new THREE.Mesh(part.geometry,makeMat(cls==='warrior'?.52:.42));halo.scale.setScalar(cls==='warrior'?1.75:1.48);halo.frustumCulled=false;part.add(halo);halos.push(halo);}
  });
  (rig.weaponRoots||[]).forEach((root,ri)=>{
    for(let i=0;i<5;i++){const haze=new THREE.Mesh(new THREE.SphereGeometry(.15+i*.025,8,6),makeMat(.12));haze.scale.set(1.4,2.4,.82);haze.position.set((ri?-.04:.04)*i,.26+i*.18,0);root.add(haze);wisps.push({mesh:haze,seed:i+ri*7});}
    for(let i=0;i<8;i++){const mote=new THREE.Mesh(new THREE.OctahedronGeometry(.028+(i%3)*.012),makeMat(.74));root.add(mote);motes.push({mesh:mote,seed:i+ri*11});}
  });
  const anchor=(rig.weaponRoots||[])[0];
  if(anchor){const light=new THREE.PointLight(colour,2.2,3.0,2);light.position.set(0,.76,0);anchor.add(light);rig.weaponIllusionLight=light;}
  rig.weaponIllusion={tick(time,dt,state){
    const surge=state.melee!=null?1.68:state.spell?1.44:1;
    halos.forEach((h,i)=>{h.material.opacity=(.32+.20*Math.sin(time*5.5+i))*surge;h.scale.setScalar((cls==='warrior'?1.64:1.40)+.12*Math.sin(time*5+i));});
    wisps.forEach(({mesh,seed})=>{mesh.material.opacity=(.08+.10*(.5+.5*Math.sin(time*3.2+seed)))*surge;mesh.position.x=Math.sin(time*2.6+seed)*.08;mesh.position.z=Math.cos(time*2.1+seed)*.06;mesh.scale.y=2.1+.8*Math.sin(time*2.8+seed);});
    motes.forEach(({mesh,seed})=>{const a=time*(2.0+(seed%3)*.3)+seed;const radius=.16+.07*Math.sin(time*1.4+seed);mesh.position.set(Math.cos(a)*radius,.30+(seed%6)*.14+Math.sin(a*1.4)*.06,Math.sin(a)*radius);mesh.rotation.y+=dt*5;mesh.material.opacity=.46+.42*Math.sin(time*4+seed);});
    if(rig.weaponIllusionLight)rig.weaponIllusionLight.intensity=(2.0+.7*Math.sin(time*5))*surge;
  }};
}
function applyShadowmoonWeapon(modelGroup,items=[]){
  if(!hasShadowmoon(items))return;
  const rig=modelGroup?.userData?.rig,root=rig?.weaponRoots?.[0];if(!rig||!root||root.userData.shadowmoon)return;
  root.userData.shadowmoon=true;
  root.children.forEach(child=>{if(child!==rig.spellFocus&&child!==rig.weaponTrail)child.visible=false;});
  const steel=new THREE.MeshStandardMaterial({color:0x203345,emissive:0x13bfe9,emissiveIntensity:.72,metalness:.92,roughness:.19,side:THREE.DoubleSide});
  const edge=new THREE.MeshStandardMaterial({color:0x9df6ff,emissive:0x16dcff,emissiveIntensity:2.8,metalness:.48,roughness:.1,side:THREE.DoubleSide});
  const dark=new THREE.MeshStandardMaterial({color:0x18131d,emissive:0x35124d,emissiveIntensity:.28,metalness:.46,roughness:.45});
  const leather=new THREE.MeshStandardMaterial({color:0x281b21,roughness:.82});
  const glow=new THREE.MeshBasicMaterial({color:0x58e7ff,transparent:true,opacity:.92,depthWrite:false,blending:THREE.AdditiveBlending});
  const purpleGlow=new THREE.MeshBasicMaterial({color:0xb34cff,transparent:true,opacity:.62,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide});
  const add=m=>{m.castShadow=false;m.receiveShadow=false;m.frustumCulled=false;root.add(m);return m;};
  const shaft=add(new THREE.Mesh(new THREE.CylinderGeometry(.052,.064,1.88,10),leather));shaft.position.y=.48;
  for(let i=0;i<9;i++){const wrap=add(new THREE.Mesh(new THREE.TorusGeometry(.066,.012,5,10),i%2?dark:steel));wrap.rotation.x=Math.PI/2;wrap.position.y=-.30+i*.17;}
  const pommel=add(new THREE.Mesh(new THREE.ConeGeometry(.12,.31,7),steel));pommel.position.y=-.61;pommel.rotation.z=Math.PI;
  const pommelGem=add(new THREE.Mesh(new THREE.OctahedronGeometry(.075),purpleGlow.clone()));pommelGem.position.y=-.55;
  const collar=add(new THREE.Mesh(new THREE.CylinderGeometry(.17,.12,.31,8),steel));collar.position.y=1.22;

  // Angular extruded blades make the silhouette read as a broad, double-headed axe.
  const bladeShape=new THREE.Shape();
  bladeShape.moveTo(.03,-.29);bladeShape.lineTo(.22,-.18);bladeShape.lineTo(.48,-.36);bladeShape.lineTo(.42,-.14);bladeShape.lineTo(.70,-.045);bladeShape.lineTo(.49,.07);bladeShape.lineTo(.61,.35);bladeShape.lineTo(.34,.23);bladeShape.lineTo(.18,.12);bladeShape.lineTo(.03,.29);bladeShape.closePath();
  const bladeGeo=new THREE.ExtrudeGeometry(bladeShape,{depth:.085,bevelEnabled:true,bevelSegments:1,bevelSize:.018,bevelThickness:.018,curveSegments:1});
  const blades=[],bladeEdges=[];
  [-1,1].forEach(side=>{
   const bladeEdge=add(new THREE.Mesh(bladeGeo,purpleGlow.clone()));bladeEdge.scale.set(side*1.07,1.07,1.18);bladeEdge.position.set(0,1.50,-.075);bladeEdges.push(bladeEdge);
   const blade=add(new THREE.Mesh(bladeGeo,steel));blade.scale.x=side;blade.position.set(0,1.50,-.025);blades.push(blade);
   const cuttingEdge=add(new THREE.Mesh(new THREE.ConeGeometry(.052,.37,7),edge));cuttingEdge.position.set(side*.67,1.50,-.005);cuttingEdge.rotation.z=-side*Math.PI/2;bladeEdges.push(cuttingEdge);
   [[.56,1.82,.31],[.61,1.18,-.34]].forEach(([x,y,angle])=>{const spike=add(new THREE.Mesh(new THREE.ConeGeometry(.055,.31,7),steel));spike.position.set(side*x,y,0);spike.rotation.z=-side*(Math.PI/2+angle);});
  });
  const topSpike=add(new THREE.Mesh(new THREE.ConeGeometry(.085,.42,8),steel));topSpike.position.y=1.98;
  const lowerSpike=add(new THREE.Mesh(new THREE.ConeGeometry(.075,.30,8),dark));lowerSpike.position.y=1.10;lowerSpike.rotation.z=Math.PI;
  const socket=add(new THREE.Mesh(new THREE.CylinderGeometry(.20,.17,.44,8),dark));socket.position.y=1.48;
  const skull=add(new THREE.Mesh(new THREE.SphereGeometry(.18,12,10),dark));skull.scale.set(1,.86,.72);skull.position.set(0,1.52,-.10);
  [-1,1].forEach(side=>{const horn=add(new THREE.Mesh(new THREE.ConeGeometry(.052,.30,7),dark));horn.position.set(side*.15,1.72,-.08);horn.rotation.z=-side*.76;const eye=add(new THREE.Mesh(new THREE.SphereGeometry(.031,7,6),glow));eye.position.set(side*.061,1.54,-.255);});
  const jaw=add(new THREE.Mesh(new THREE.ConeGeometry(.105,.23,7),dark));jaw.position.set(0,1.33,-.08);jaw.rotation.z=Math.PI;
  const runes=[];[-1,1].forEach(side=>{for(let i=0;i<4;i++){const rune=add(new THREE.Mesh(new THREE.OctahedronGeometry(.037+i*.004),glow.clone()));rune.position.set(side*(.26+i*.09),1.39+i*.075,-.115);rune.scale.set(.52,1,.32);runes.push(rune);}});
  const haze=add(new THREE.Mesh(new THREE.TorusGeometry(.66,.050,8,42),purpleGlow.clone()));haze.position.y=1.50;
  const axeAura=add(new THREE.Mesh(new THREE.RingGeometry(.38,.78,32),purpleGlow.clone()));axeAura.position.set(0,1.50,.02);axeAura.material.opacity=.24;
  rig.weaponGlowParts=[...bladeEdges,...runes];
  if(rig.weaponTrail?.material?.color){rig.weaponTrail.visible=true;rig.weaponTrail.material.color.setHex(0xa83fff);rig.weaponTrail.material.opacity=.72;}
  rig.shadowmoonVisual={tick:(time,dt,state)=>{const surge=state.melee!=null?1.55:1;edge.emissiveIntensity=(2.5+.9*Math.sin(time*5.5))*surge;haze.rotation.z+=dt*1.7;haze.material.opacity=(.36+.18*Math.sin(time*4))*surge;axeAura.rotation.z-=dt*.9;axeAura.material.opacity=(.18+.13*Math.sin(time*3.2+1))*surge;bladeEdges.forEach((part,i)=>{if(part.material.opacity!==undefined)part.material.opacity=(.48+.20*Math.sin(time*4.7+i))*surge;});runes.forEach((r,i)=>{r.material.opacity=.64+.34*Math.sin(time*5+i);r.rotation.y+=dt*(2+i*.15);});}};
  const prior=rig.weaponIllusion;rig.weaponIllusion={tick(time,dt,state){prior?.tick?.(time,dt,state);rig.shadowmoonVisual.tick(time,dt,state);}};
}
const $ = s => document.querySelector(s);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const fmt=t=>`${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`;
const COLORS={ally:0x27d2d9, enemy:0xee4165, heal:0x55eb9c, shield:0x52bfff, fire:0xff7436, shadow:0x8f56ec, storm:0x53dfff, wind:0x72e5a5, soul:0xb85cff, holy:0xffd466, discipline:0xf4f5ff, cc:0xc994ff, warrior:0xc0392b};
const BALANCE={dpsHP:1500, healerHP:1375, manaRegen:.82, healerManaRegen:2.38, duelistManaRegen:1.42, stormManaRegen:1.48, soulManaRegen:2.35, energyRegen:16, gcd:1, dampStart:30, dampInterval:10, dampStep:.05, dampCap:.99, ccDRReset:18, polyBreaksOnDamage:true, arenaX:32, arenaZ:22, unitRadius:.62};
const DIFFICULTY={easy:{min:.55,max:.9,interrupt:.18,kite:.20},normal:{min:.3,max:.6,interrupt:.48,kite:.42},hard:{min:.17,max:.38,interrupt:.74,kite:.68}};
const DEFAULT_BINDS={a1:'Digit1',a2:'Digit2',a3:'Digit3',a4:'Digit4',a5:'Digit5',a6:'Digit6',a7:'Digit7',a8:'Digit8',a9:'Digit9',a10:'Digit0',a11:'Minus',a12:'Equal',a13:'BracketLeft',a14:'BracketRight',a15:'Semicolon',a16:'Quote',trinket:'KeyQ',mount:'KeyR',enemy:'Tab',ally:'KeyF',forward:'KeyW',backward:'KeyS',left:'KeyA',right:'KeyD',jump:'Space',mobility:'KeyV',pause:'KeyP'};
let savedBinds={};try{savedBinds=JSON.parse(localStorage.getItem('aetherBinds')||'{}')||{};}catch(e){savedBinds={};}
if(savedBinds.mobility==='Space'&&!savedBinds.jump)savedBinds.mobility='KeyV';
let binds={...DEFAULT_BINDS,...savedBinds};
let abilityLayouts={};
try{abilityLayouts=JSON.parse(localStorage.getItem('aetherAbilityLayouts')||'{}')||{};}catch(e){abilityLayouts={};}
const BIND_LABEL={Digit1:'1',Digit2:'2',Digit3:'3',Digit4:'4',Digit5:'5',Digit6:'6',Digit7:'7',Digit8:'8',Digit9:'9',Digit0:'0',Minus:'-',Equal:'=',BracketLeft:'[',BracketRight:']',Semicolon:';',Quote:"'",KeyQ:'Q',KeyR:'R',KeyV:'V',KeyW:'W',KeyA:'A',KeyS:'S',KeyD:'D',Tab:'Tab',KeyF:'F',Space:'Space',ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→',KeyP:'P',Escape:'Esc',Backquote:'`'};
function keyLabel(k){return BIND_LABEL[k]||String(k||'—').replace('Key','').replace('Digit','');}
function bindLabel(k){return String(k||'').includes('+')?comboLabel(k):keyLabel(k);}
function eventCombo(e){const mods=[];if(e.ctrlKey)mods.push('Ctrl');if(e.shiftKey)mods.push('Shift');if(e.altKey)mods.push('Alt');if(e.metaKey)mods.push('Meta');mods.push(e.code);return mods.join('+');}
function comboLabel(combo){if(!combo)return 'Unbound';const shortModifier={Ctrl:'C',Shift:'S',Alt:'A',Meta:'M'};return combo.split('+').map(p=>shortModifier[p]||keyLabel(p)).join(' + ');}
const DEFAULT_FOCUS_ABILITY={flame:4,shadow:4,storm:2,wind:4,soul:4,sage:6,pala:5,disc:8};
let focusCasts=JSON.parse(localStorage.getItem('aetherFocusCasts')||'{}');
function ensureFocusClass(cls){let saved=focusCasts[cls];if(Array.isArray(saved)){const migrated={};saved.forEach(m=>{const ability=String(Number.isInteger(m.ability)?m.ability:(DEFAULT_FOCUS_ABILITY[cls]??0));if(!migrated[ability])migrated[ability]=[0,1,2].map(enemySlot=>({enemySlot,key:''}));if(migrated[ability][m.enemySlot||0])migrated[ability][m.enemySlot||0].key=m.key||'';});focusCasts[cls]=migrated;saved=migrated;}if(!saved||Array.isArray(saved)){saved={};focusCasts[cls]=saved;}return saved;}
function getFocusCasts(cls,abilityIndex=DEFAULT_FOCUS_ABILITY[cls]??0){const saved=ensureFocusClass(cls),key=String(abilityIndex);if(!saved[key])saved[key]=[0,1,2].map(enemySlot=>({enemySlot,key:''}));return saved[key];}
const AB={
 flame:[
  {name:'Cinder Bolt',icon:'🔥',type:'damage',school:'fire',range:26,cast:1.45,cd:0,cost:4,value:130,tip:'Launch a casted ember projectile dealing 130 fire damage. A successful hit restores 4 mana.'},
  {name:'Ember Lance',icon:'☄️',type:'damage',school:'fire',range:24,cast:0,cd:7,cost:6,value:158,tip:'Instant fire damage. Deals 30% extra to burning targets. Once Meteorfall lands, your next Ember Lance becomes a rapid off-global Meteor Lance that deals 15% extra damage.'},
  {name:'Frostfire Nova',icon:'❄️',type:'flameNova',school:'fire',range:8,cast:0,cd:18,cost:4,value:36,tip:'Usable while moving and off-global: deal 36 damage, root nearby enemies for 4 sec and slow them by 60% for 6 sec.'},
  {name:'Blazing Step',icon:'💨',type:'dash',school:'fire',range:0,cast:0,cd:18,cost:5,value:0,tip:'Blink 15m in your movement direction and leave an ember path. While casting Prism Hex or Cinder Bolt, Blazing Step is off-global and does not interrupt the cast.'},
  {name:'Prism Hex',icon:'🐑',type:'poly',school:'arcane',range:22,cast:1.45,cd:5,cost:4,value:7,tip:'Transform an enemy into a sheep for 7 sec. Costs 4 mana. Breaks on damage and follows incapacitate diminishing returns.'},
  {name:'Counterflare',icon:'🔶',type:'interruptProc',school:'fire',range:22,cast:0,cd:15,cost:0,value:0,tip:'Usable while moving and off-global. Interrupt a cast; success restores 20 mana and grants two instant +20% Cinder Bolts.'},
  {name:'Ice Block',icon:'🧊',type:'iceBlock',school:'frost',range:0,cast:0,cd:50,cost:0,value:0,tip:'Off-global defensive. Encases you in ice for up to 8 sec: immune to damage and heal for 20% maximum health over the full duration, but unable to attack. Can be used while crowd controlled and breaks stuns, roots and other control effects. Press again to cancel early.'},
  {name:'Meteor',icon:'☄️',type:'meteor',school:'fire',range:25,cast:0,cd:20,cost:8,value:205,tip:'Call down Meteor at the selected enemy location. After 0.98 sec it deals 205 fire damage within 5.2m, burns targets for 17 damage per second for 5 sec, and readies Meteor Lance. You choose the burst window.'}
 ],
 shadow:[
  {name:'Night Slash',icon:'🗡️',type:'damage',school:'physical',range:3.9,cast:0,cd:0,cost:18,value:59,tip:'Strike the selected enemy for 59 physical damage. Each hit builds a Shadow Mark; at 3 marks, Viper Cut becomes empowered.'},
  {name:'Umbral Pounce',icon:'🌑',type:'leap',school:'shadow',range:18,cast:0,cd:14,cost:24,value:90,tip:'Leap to an enemy and strike for 90 damage. For 1.5 sec after landing, gain a 50% chance to dodge each incoming melee attack.'},
  {name:'Viper Cut',icon:'🦂',type:'dot',school:'shadow',range:3.9,cast:0,cd:9,cost:25,value:70,tip:'Deal 70 damage and poison the enemy for 8 sec. Consumes Venom Edge for a stronger strike and poison.'},
  {name:'Smoke Veil',icon:'🌫️',type:'defensive',school:'shadow',range:0,cast:0,cd:38,cost:0,value:0,tip:'Reduce damage taken by 35% for 4 sec and gain +10% damage for 8 sec. Arms your next Night Slash to Cheap Shot for 3 sec and your next Ribbreaker to deploy Smoke Bomb.'},
  {name:'Blind',icon:'👁️',type:'blind',school:'shadow',range:15,cast:0,cd:40,cost:15,value:5,tip:'Blind the selected enemy, preventing actions for 5 sec. Damage breaks the effect. Long 40 sec setup cooldown.'},
  {name:'Ribbreaker',icon:'🩸',type:'singleStun',school:'physical',range:3.8,cast:0,cd:20,cost:30,value:35,tip:'Strike for 35 damage and stun the enemy for 4 sec. Landing it empowers your next Night Slash into Eviscerate for 45% more damage. With the Vendetta branch learned, Ribbreaker also applies Internal Bleeding for 6 sec. After Smoke Veil, it deploys Smoke Bomb.'},
  {name:'Shadow Kick',icon:'🥾',type:'shadowInterrupt',school:'physical',range:3.8,cast:0,cd:15,cost:10,value:36,tip:'Off-global melee kick. Deals 36 damage and, if the target is casting, interrupts and locks that school for 3 sec.'}
 ],
 storm:[
  {name:'Arc Spark',icon:'⚡',type:'damage',school:'storm',range:25,cast:1.15,cd:0,cost:5,value:124,tip:'Deal 124 damage and restore 4 mana. Each hit rolls Storm Surge. Lightning Rod can only be created by an Arc Spark empowered by Stormkeeper.'},
  {name:'Forked Current',icon:'🔱',type:'chain',school:'storm',range:24,cast:0,cd:4,cost:7,value:132,tip:'Shock the target for 132 damage and arc to nearby enemies. Lightning Rod increases its damage by 20%. Consuming Volcanic Overload restores additional mana and automatically hurls three smaller Lava Bursts at every enemy in your line of sight.'},
  {name:'Skybreaker Pulse',icon:'🌩️',type:'stun',school:'storm',range:7,cast:0,cd:27,cost:0,value:55,tip:'Free, usable while moving and off-global. Burst nearby enemies for 55 damage, stun for 4 sec, and ready one Volcanic Eruption. Subject to stun diminishing returns.'},
  {name:'Static Aegis',icon:'🔵',type:'shieldSelf',school:'storm',range:0,cast:0,cd:29,cost:10,value:268,tip:'Gain a shield absorbing 268 damage and reduce damage taken by 20% for 6 sec.'},
  {name:'Gale Reversal',icon:'🌪️',type:'push',school:'storm',range:9,cast:0,cd:17,cost:0,value:0,tip:'Free. Push a nearby enemy back or leap backwards if none is near.'},
  {name:'Static Snare',icon:'🕸️',type:'root',school:'storm',range:22,cast:0,cd:18,cost:0,value:4,tip:'Free. Root an enemy in place for 4 sec. The target may still cast.'},
  {name:'Wind Shear',icon:'🌬️',type:'interrupt',school:'storm',range:25,cast:0,cd:12,cost:0,value:0,tip:'Off-global ranged interrupt. Shear an enemy cast and lock its spell school for 2.5 sec.'},
  {name:'Flame Shock',icon:'🔥',type:'flameShock',school:'storm',range:25,cast:0,cd:0,cost:4,value:34,tip:'Apply a 12 sec fire damage-over-time effect with no cooldown. Maintain it on any number of enemies. Damage doubled; it no longer resets or procs another spell.'}
 ],
 wind:[
  {name:'Zephyr Palm',icon:'👊',type:'damage',school:'wind',range:4.1,cast:0,cd:0,cost:16,value:50,tip:'Strike for 50 damage and build one Flow. Strike of the Windlord transforms your next Zephyr Palm into Rising Sun Kick.'},
  {name:'Cloudstep Kick',icon:'🦶',type:'leap',school:'wind',range:4.1,cast:0,cd:8,cost:23,value:127,tip:'Kick the selected enemy for 127 damage. Uses the global cooldown. Every 20 sec it becomes Cloudstep Dash, leaping from up to 17m and dealing 20% more damage.'},
  {name:'Fists of Fury',icon:'🥊',type:'fistsChannel',school:'wind',range:5.0,cast:2.5,cd:18,cost:18,value:68,tip:'Standalone 18 sec cooldown channel. Move at 30% speed while channeling and slow enemies in the area by 60%. Press Fists of Fury again to cancel the channel early.'},
  {name:'Disrupting Palm',icon:'✋',type:'windInterrupt',school:'wind',range:3.8,cast:0,cd:15,cost:12,value:48,tip:'Strike for 48 damage. If the target is casting, interrupt it for 3 sec and immediately gain one Flow stack.'},
  {name:'Valley Sweep',icon:'🌀',type:'windStun',school:'wind',range:5.4,cast:0,cd:30,cost:28,value:42,tip:'Sweep nearby enemies off balance, dealing light damage and stunning for 5 sec. Subject to stun diminishing returns.'},
  {name:'Willow Guard',icon:'☯️',type:'monkDefensive',school:'wind',range:0,cast:0,cd:34,cost:0,value:0,tip:'Defensive stance. Reduce incoming damage by 50% for 6 sec and immediately heal yourself for 135. A large jade willow barrier clearly shows the defensive.'},
  {name:'Incapacitate',icon:'💫',type:'windIncap',school:'wind',range:20,cast:0,cd:25,cost:14,value:3,tip:'Usable while moving. Incapacitate an enemy at range for 3 sec. Breaks on damage and shares DR with Prism Hex, Blind and Lullaby Bloom.'},
  {name:'Whirling Dragon Punch',icon:'🐉',type:'whirlingDragonPunch',school:'wind',range:5.5,cast:0,cd:24,cost:12,value:180,tip:'Off-global. Perform a whirling upward strike for 180 damage to every nearby visible enemy. Only usable while Fists of Fury is on cooldown.'}
 ],
 soul:[
  {name:'Soul Scar',icon:'🕯️',type:'soulDot',school:'shadow',range:25,cast:0,cd:0,cost:2,value:31.5,tip:'Mark the target with soul decay, dealing 31.5 shadow damage each second for 15 sec.'},
  {name:'Creeping Torment',icon:'🪬',type:'agony',school:'shadow',range:25,cast:0,cd:0,cost:2,value:10.8,tip:'Curse the target for 15 sec. The curse grows stronger with each tick.'},
  {name:'Unstable Affliction',icon:'🟣',type:'unstableAffliction',school:'shadow',range:25,cast:1.25,cd:0,cost:2,value:50,tip:'Afflict the target for 10 sec. One stack ticks for 50 damage, two stacks tick for 80 total, and three stacks tick for 110 total. Stacks also strengthen Essence Siphon.'},
  {name:'Essence Siphon',icon:'👻',type:'soulDrain',school:'shadow',range:24,cast:0,cd:12,cost:3,value:47,tip:'Channel for 2.5 sec, draining the target every 0.5 sec. Soul Scar and Creeping Torment strengthen each tick, and Essence Siphon healing is increased by 30%.'},
  {name:'Grasping Gloom',icon:'🖤',type:'root',school:'shadow',range:22,cast:0,cd:18,cost:0,value:4,tip:'Off-global. Bind the target in shadow for 4 sec. Shares root diminishing returns.'},
  {name:'Soul Barrier',icon:'🔮',type:'shieldSelf',school:'shadow',range:0,cast:0,cd:28,cost:2,value:225,tip:'Surround yourself with a barrier absorbing 225 damage for 6 sec and become immune to interrupts for its duration.'},
  {name:'Fear',icon:'😱',type:'fear',school:'shadow',range:24,cast:1.15,cd:15,cost:2,value:3.5,tip:'Fear an enemy for 3.5 sec. Soulweaver fear does not break from periodic DoTs, but still breaks from direct/physical damage.'}
 ],
 pala:[
  {name:'Holy Light',icon:'🌟',type:'holyLight',school:'holy',range:28,cast:1.50,cd:0,cost:6,value:190,tip:'Your spammable 1.5 sec holy heal, restoring 190 health. Infusion of Light reduces the next Holy Light cast time by 50% and refunds some mana.'},
  {name:'Holy Shock',icon:'⚡',type:'holyShock',school:'holy',range:28,cast:0,cd:6,cost:8,value:168,damageValue:112,tip:'Instant holy spell. Heals an ally for 168 or damages an enemy for 112. Either use has a 35% critical chance; critical Holy Shock grants Infusion of Light, making the next Holy Light 50% faster and refunding mana.'},
  {name:'Blessing of Sacrifice',icon:'🪽',type:'sacrifice',school:'holy',range:28,cast:0,cd:32,cost:10,value:0,tip:'Protect an ally for 6 sec, redirecting their incoming damage to you. Also grants Avenging Wings, increasing your healing by 20% for 6 sec.'},
  {name:'Bestow Faith',icon:'🙏',type:'bestowFaith',school:'holy',range:28,cast:0,cd:12,cost:10,value:240,tip:'Place faith on yourself or an ally. After 4 sec, the target is healed for 240 health. Use it proactively before incoming damage.'},
  {name:'Divine Protection',icon:'🛡️',type:'paladinGuard',school:'holy',range:0,cast:0,cd:32,cost:0,value:0,tip:'Reduce your incoming damage by 30% for 6 sec. Useful before committing to Blessing of Sacrifice.'},
  {name:'Hammer of Justice',icon:'🔨',type:'paladinStun',school:'holy',range:10,cast:0,cd:30,cost:8,value:4.5,tip:'Stun an enemy for 4.5 sec. Shares normal stun diminishing returns with other stun effects.'},
  {name:'Divine Steed',icon:'🐴',type:'paladinSteed',school:'holy',range:0,cast:0,cd:30,cost:0,value:0,tip:'Off-global mobility: summon your full-sized active mount in radiant holy light for 3 sec, increasing movement speed by 65% while usable in combat.'},
  {name:'Cleanse',icon:'💧',type:'cleanse',school:'holy',range:28,cast:0,cd:8,cost:5,value:0,tip:'Dispel one removable Polymorph, Sleep, Blind, Fear, Root or Snare from an ally. Cannot remove Stuns. 8 sec cooldown.'},
  {name:'Avenging Wings',icon:'🪽',type:'avengingWings',school:'holy',range:0,cast:0,cd:60,cost:0,value:0,tip:'Off-global 60 sec cooldown. Unfurl radiant wings for 8 sec, increasing all healing and damage by 20%.'}
 ],
 sage:[
  {name:'Verdant Mend',icon:'🍃',type:'heal',school:'nature',range:28,cast:1.50,cd:0,cost:6,value:202,tip:'1.5 sec cast. Restore 202 health to an ally. A faster, efficient core heal that remains interruptible.'},
  {name:'Blooming Echo',icon:'🌱',type:'hot',school:'nature',range:27,cast:0,cd:0,cost:8,value:51,tickValue:23,tip:'Restore 51 health, then 23 health each second for 12 sec. Reapplying refreshes only Blooming Echo; Rejuvenate remains active separately.'},
  {name:'Spirit Blossom',icon:'🌳',type:'spiritBlossom',school:'nature',range:26,cast:0,cd:18,cost:10,value:48.4,tip:'Plant a radiant healing tree for 9 sec. Allies within 6m are healed for 48.4 and gain 23 absorption every second.'},
  {name:'Renewal Tide',icon:'💚',type:'bigHeal',school:'nature',range:28,cast:0,cd:30,cost:18,value:782,tip:'An instant emergency recovery button restoring 782 health. Lifesage AI can cancel a slower heal and use Renewal Tide immediately when health drops sharply or enemy burst/procs create lethal pressure.'},
  {name:'Purifying Light',icon:'✨',type:'cleanse',school:'nature',range:28,cast:0,cd:8,cost:5,value:0,tip:'Dispel one removable Polymorph, Sleep, Blind, Fear, Root or Snare from an ally. Cannot remove Stuns. 8 sec cooldown.'},
  {name:'Fae Retreat',icon:'🪽',type:'healerEscape',school:'nature',range:0,cast:0,cd:26,cost:6,value:0,tip:'Leap 9m away from danger and reduce damage taken by 30% for 3 sec.'},
  {name:'Lullaby Bloom',icon:'🌸',type:'sleep',school:'nature',range:24,cast:1.25,cd:22,cost:8,value:4.5,tip:'Castable while moving. Place an enemy into magical slumber for 4.5 sec. Breaks on damage and shares diminishing returns with Polymorph.'},
  {name:"G'Hanir, the Mother Tree",icon:'🌲',type:'ghanir',school:'nature',range:0,cast:0,cd:45,cost:8,value:0,tip:'For 7 sec, increase Blooming Echo and Rejuvenate healing by 50% and make their periodic ticks occur 50% faster. HoT durations are unchanged, so the faster ticks provide additional healing rather than expiring the effects early.'}
 ],
 disc:[
  {name:'Smite',icon:'✨',type:'discSmite',school:'holy',range:25,cast:1.15,cd:0,cost:4,value:61,atonementHeal:112,tip:'Deal 61 holy damage after the additional 20% damage increase. Every ally carrying Atonement is still healed for 112 before normal Atonement modifiers; this damage tuning does not increase its healing value.'},
  {name:'Power Shield',icon:'🔵',type:'discShield',school:'holy',range:28,cast:0,cd:6,cost:6,value:282,atonementDuration:14,tip:'Costs 6 mana. Shield yourself or an ally for 282 absorption and apply Atonement for 14 sec. Your damaging Discipline spells heal every ally with Atonement.'},
  {name:'Penance',icon:'🌠',type:'discPenance',school:'holy',range:25,cast:1.5,cd:10,cost:8,value:82,atonementHeal:78,directHeal:132,tip:'Costs 8 mana. Channel three luminous bolts over 1.5 sec while moving and jumping. Each offensive bolt deals 82 damage. Atonement healing remains 78 per bolt before modifiers, and friendly Penance remains 132 direct healing per bolt. Ultimate Radiance empowers your next Penance.'},
  {name:'Shadow Mend',icon:'🌓',type:'discMend',school:'shadow',range:28,cast:1.4,cd:0,cost:6,value:286,tip:'Emergency 1.4 sec direct heal for 286 (20% stronger), costing 6 mana, and apply Atonement for 14 sec. Casting it on yourself also grants 10% damage reduction for 4 sec. Efficient Discipline play normally heals through Atonement damage first.'},
  {name:'Solace',icon:'☀️',type:'discSolace',school:'holy',range:25,cast:0,cd:12,cost:0,value:123,atonementHeal:132,tip:'Instant holy bolt for 123 damage after the additional 40% damage buff. It still heals every Atonement ally for 132 and restores 7 mana; the damage increase does not raise its healing value.'},
  {name:'Pain Suppression',icon:'🕊️',type:'painSuppression',school:'holy',range:28,cast:0,cd:45,cost:10,value:0,tip:'Reduce damage taken by the chosen ally by 60% for 5 sec. Discipline AI uses it before or during lethal offensive cooldowns.'},
  {name:'Ultimate Radiance',icon:'🌟',type:'ultimateRadiance',school:'holy',range:0,cast:0,cd:32,cost:20,value:565,atonementDuration:10,tip:'Last-resort instant group recovery. Heal every living ally for 565, apply Atonement for 10 sec and grant Radiant Penance for 12 sec. Your next Penance channels 30% faster; offensive bolts deal 15% more damage and its Atonement healing is increased by 15%.'},
  {name:'Purify',icon:'💠',type:'cleanse',school:'holy',range:28,cast:0,cd:8,cost:5,value:0,tip:'Dispel one removable Polymorph, Sleep, Blind, Fear, Root or Snare from an ally. Discipline prioritises removing Polymorph before committing to damage.'},
  {name:'Psychic Scream',icon:'🪽',type:'discFear',school:'shadow',range:0,cast:0,cd:35,cost:4,value:4,tip:'Costs 4 mana. Fear visible enemies within 8m for 4 sec. The fear respects line of sight and breaks from damage.'},
  {name:'Fade',icon:'🤍',type:'discFade',school:'holy',range:0,cast:0,cd:28,cost:0,value:0,tip:'Fade into white light, reducing damage taken by 30% and increasing movement speed by 25% for 4 sec. Used to survive swaps and reach safer pillar positions.'}
 ],
 warrior:[
  {name:'Mortal Swing',icon:'⚔️',type:'mortalSwing',school:'physical',range:4.0,cast:0,cd:0,cost:18,value:104,tip:'Strike for 104 damage. Pummel and Warbreaker can empower this hit; consuming Warbreaker also triggers three Slicing Winds for 60% Mortal Swing damage each. Sharpen Blade makes this strike apply its healing reduction.'},
  {name:'Charge',icon:'🐎',type:'charge',school:'physical',range:17,cast:0,cd:14,cost:8,value:42,tip:'Charge from up to 17m, dealing 42 damage, rooting the target for 1.5 sec, then snaring them by 45% for 4 sec.'},
  {name:'Rend',icon:'🩸',type:'rend',school:'physical',range:4.0,cast:0,cd:6,cost:20,value:59,tip:'Strike for 59 damage and bleed the target for 33 damage each second over 9 sec. Each Rend has a 30% chance to expose Gushing Wound.'},
  {name:'Pummel',icon:'🥊',type:'pummel',school:'physical',range:3.8,cast:0,cd:15,cost:10,value:30,tip:'Off-global kick for 30 damage. Interrupting a cast locks that school for 3 sec and readies one Mortal Swing that deals 30% more damage.'},
  {name:'Spell Reflection',icon:'🛡️',type:'reflect',school:'physical',range:0,cast:0,cd:25,cost:10,value:0,tip:'Off-global. For 2.5 sec, reflect damaging spells, casted crowd control and Hammer of Justice back at their caster. Does not reflect Fists of Fury, Skybreaker Pulse or melee strikes.'},
  {name:'Intimidating Shout',icon:'😱',type:'shout',school:'physical',range:0,cast:0,cd:35,cost:15,value:4,tip:'Bellow a war cry, fearing all enemies within 8m for 4 sec. Warrior fear breaks from any damage, including DoTs.'},
  {name:'Shield Wall',icon:'🛡️',type:'warriorGuard',school:'physical',range:0,cast:0,cd:40,cost:0,value:0,tip:'Off-global. Reduce all damage taken by 60% for 6 sec, but reduce your damage dealt by 25% while active. Passive interaction: pressing Shield Wall empowers your next Victory Rush to heal 60% more.'}
 ]
};
const ABILITY_ART=(typeof window!=='undefined'?window:globalThis).AETHER_ABILITY_ART||{};
function spellArtPath(name){const ref=ABILITY_ART[name];return ref?`./spell-icons/${ref}.webp`:'';}
function spellIcon(name,fallback='✦'){const src=spellArtPath(name);return src?`<img class="spell-art" src="${src}" alt="" draggable="false">`:fallback;}
function abilityIcon(ability){return spellIcon(ability?.name,ability?.icon||'✦');}
const TALENT_ART_PACKS=(typeof window!=='undefined'?window:globalThis).AETHER_TALENT_PACKS||{};
function talentArtClass(node){for(const [cls,nodes] of Object.entries(TALENT_TREES||{}))if(nodes.includes(node))return cls;const id=String(node?.id||'');if(id.startsWith('war_')||id.startsWith('warrior'))return'warrior';return id.split('_')[0]||'flame';}
function talentArtPath(node){const exact=spellArtPath(node?.name);if(exact)return exact;const pack=TALENT_ART_PACKS[talentArtClass(node)]||TALENT_ART_PACKS.flame||[];if(!pack.length)return'';const seed=String(node?.id||node?.name||'talent');let hash=0;for(let i=0;i<seed.length;i++)hash=(hash*31+seed.charCodeAt(i))>>>0;return`./spell-icons/${pack[hash%pack.length]}.webp`;}
function talentIcon(node){const src=talentArtPath(node);return src?`<img class="spell-art" src="${src}" alt="" draggable="false">`:(node?.icon||'✦');}
function setSpellIcon(element,name,fallback='✦'){if(!element)return;const html=spellIcon(name,fallback);if(element.__aetherHtml===html)return;element.innerHTML=html;element.__aetherHtml=html;}
const CLASS_ART=Object.freeze({flame:'flame',shadow:'shadow',storm:'storm',wind:'wind',soul:'soul',sage:'sage',pala:'pala',disc:'disc',warrior:'warrior'});
function classIcon(cls,fallback='✦'){const ref=CLASS_ART[cls];return ref?`<img class="class-art" src="./spell-icons/classes/${ref}.webp" alt="" draggable="false">`:fallback;}
const CLASS_INFO={flame:{name:'Flame Duelist',short:'FLAME',badge:'🔥',role:'Caster',resource:'mana',colour:COLORS.fire},shadow:{name:'Shadowblade',short:'SHADOW',badge:'🗡️',role:'Melee',resource:'energy',colour:COLORS.shadow},storm:{name:'Stormwarden',short:'STORM',badge:'⚡',role:'Control',resource:'mana',colour:COLORS.storm},wind:{name:'Windwalker',short:'WIND',badge:'🍃',role:'Martial',resource:'energy',colour:COLORS.wind},soul:{name:'Soulweaver',short:'SOUL',badge:'👻',role:'Affliction',resource:'mana',colour:COLORS.soul},sage:{name:'Lifesage',short:'SAGE',badge:'🌿',role:'Healer',resource:'mana',colour:COLORS.heal},pala:{name:'Paladin',short:'HOLY',badge:'🛡️',role:'Healer',resource:'mana',colour:COLORS.holy},disc:{name:'Discipline',short:'DISC',badge:'✦',role:'Atonement Healer',resource:'mana',colour:COLORS.discipline},warrior:{name:'Warrior',short:'WAR',badge:'⚔️',role:'Melee',resource:'energy',colour:COLORS.warrior}};

const TALENT_UNLOCKED_ABILITIES={
 disc:{
  disc_archangel:{name:'Archangel',icon:'🪽',type:'archangel',school:'holy',range:0,cast:0,cd:45,cost:0,value:0,tip:'Choice talent. Gain small white priest wings for 12 sec and increase all healing produced through Atonement by 30%.'},
  disc_dark_archangel:{name:'Dark Archangel',icon:'🖤',type:'darkArchangel',school:'shadow',range:0,cast:0,cd:45,cost:0,value:0,tip:'Choice talent. Gain dark violet priest wings for 12 sec and increase all Discipline damage dealt by 30%.'},
  disc_angelic_body:{name:'Angelic Body',icon:'💨',type:'angelicBody',school:'holy',range:0,cast:0,cd:30,cost:0,value:0,tip:'Talent ability. Gain 30% additional movement speed for 5 sec. Use it to restore healing line of sight or escape a swap.'}
 },
 flame:{flame_meteor_spear:{name:'Meteor Spear',icon:'🌠',type:'damage',school:'fire',range:24,cast:0,cd:18,cost:10,value:205,tip:'Talent ability. Hurl a compact meteor spear for 205 fire damage. Designed as an extra burst button after choosing Meteor Impact.'},flame_phoenix_guard:{name:'Alter Time',icon:'⏳',type:'defensive',school:'arcane',range:0,cast:0,cd:0,cost:0,value:0,tip:'Save your current location and health for 5 sec. Recast during that window—or let it expire—to return to the saved state. 1 min cooldown begins when you return.'},flame_inferno_wave:{name:'Inferno Wave',icon:'🌊',type:'flameNova',school:'fire',range:0,cast:0,cd:24,cost:16,value:72,tip:'Talent ability. Release close-range fire pressure.'},flame_cauterize:{name:'Cauterize',icon:'❤️‍🔥',type:'passiveOnly',school:'fire',range:0,cast:0,cd:0,cost:0,value:0,tip:'Passive cheat death. The first lethal hit leaves you at 30% health and grants 50% movement speed before you burn out after 5 sec.'}},
 warrior:{war_execute_strike:{name:'Stormbolt',icon:'🔮',type:'stormbolt',school:'physical',range:22,cast:0,cd:25,cost:15,value:3,tip:'Talent ability. Hurl a violet storm bolt up to 22m. When the missile connects, it stuns the target for 3 sec and follows normal stun diminishing returns.'},war_rallying_wall:{name:'Sharpen Blade',icon:'🗡️',type:'sharpenBlade',school:'physical',range:0,cast:0,cd:45,cost:0,value:0,tip:'Talent ability. Your next Mortal Swing makes its target receive 40% less healing for 3 sec. You restore 3% maximum health each second for those 3 sec; this 9% total ignores dampening.'},war_skullbreaker:{name:'Avatar',icon:'🗿',type:'avatar',school:'physical',range:0,cast:0,cd:50,cost:0,value:0,tip:'Talent ability. Increase all damage you deal by 18% for 10 sec. If you are rooted when Avatar is pressed, it removes the current root once, but does not grant root immunity afterwards.'},war_battle_banner:{name:'Intercept',icon:'🛡️',type:'intercept',school:'physical',range:25,cast:0,cd:25,cost:0,value:0,tip:'Talent ability. Charge to an allied champion and redirect all damage they would take to you for 4 sec.'}},
 storm:{storm_lava_burst:{name:'Volcanic Eruption',icon:'🌋',type:'volcanicEruption',school:'storm',range:24,cast:0,cd:0,cost:8,value:353,tip:'Instant off-global eruption dealing 353 damage, then automatically launching two Lava Bursts for roughly 60 damage each. Skybreaker Pulse readies exactly one use; the button remains unavailable until then.'},storm_grounding_aegis:{name:'Grounding Aegis',icon:'🌀',type:'shieldSelf',school:'storm',range:0,cast:0,cd:32,cost:10,value:320,tip:'Shield yourself for 320 damage, helping you survive while casting.'},storm_static_field:{name:'Healing Stream Totem',icon:'💧',type:'healingStreamTotem',school:'storm',range:0,cast:0,cd:30,cost:14,value:90,tip:'Summon a killable Healing Stream Totem with 280 health at your feet for 10 sec. It heals group members within 18m for 90 every 2 sec.'},storm_chain_spark:{name:'Healing Surge',icon:'🔗',type:'heal',school:'storm',range:28,cast:.75,cd:12,cost:10,value:340,tip:'0.75 sec cast. Restore 340 health to yourself or an ally before gear, critical strikes and dampening.'}},
 soul:{soul_pandemic_bloom:{name:'Pandemic Bloom',icon:'🧫',type:'damage',school:'shadow',range:25,cast:0,cd:14,cost:8,value:274,tip:'Instantly deal 274 shadow damage. Shadowfury empowers the next Pandemic Bloom by 20%.'},soul_void_mend:{name:'Void Mend',icon:'💗',type:'soulDrain',school:'shadow',range:24,cast:0,cd:20,cost:6,value:45,tip:'Drain an enemy to damage them and stabilise yourself.'},soul_horror:{name:'Mortal Horror',icon:'😱',type:'fear',school:'shadow',range:20,cast:0,cd:15,cost:0,value:3.5,tip:'Fear the target for 3.5 sec and heal yourself for 20% maximum health before dampening. Periodic damage does not break this fear.'},soul_dark_pact:{name:'Dark Pact',icon:'🕳️',type:'shieldSelf',school:'shadow',range:0,cast:0,cd:40,cost:8,value:360,tip:'Surround yourself with a powerful shadow shield.'}},
 sage:{sage_spirit_bloom:{name:'Ironbark',icon:'🌳',type:'ironbark',school:'nature',range:28,cast:0,cd:30,cost:10,value:0,tip:'For 6 sec, reduce damage taken by 20% and increase all healing received by 20%. Can be used on yourself or an ally.'},sage_natures_grasp:{name:'Nature’s Grasp',icon:'🌾',type:'root',school:'nature',range:22,cast:0,cd:28,cost:12,value:3.5,tip:'Root the selected enemy.'},sage_rejuvenate:{name:'Rejuvenate',icon:'🌺',type:'hot',school:'nature',range:28,cast:0,cd:0,cost:8,value:90,tickValue:28,tip:'Restore 90 health immediately, then 28 health each second for 12 sec. Reapplying refreshes only Rejuvenate; Blooming Echo remains active separately.'}},
 pala:{pala_guardian_angel:{name:'Guardian Angel',icon:'👼',type:'shield',school:'holy',range:28,cast:0,cd:30,cost:10,value:315,tip:'Talent ability. Place a powerful holy shield on an ally to answer swaps.'},pala_divine_toll:{name:'Divine Toll',icon:'🔔',type:'holyShock',school:'holy',range:28,cast:0,cd:22,cost:12,value:168,damageValue:112,shots:3,tip:'Talent ability. Fire three Holy Shocks into the selected ally or enemy. Each shot can critically heal or damage and can grant Infusion of Light.'},pala_freedom:{name:'Blessing of Freedom',icon:'🪽',type:'cleanse',school:'holy',range:28,cast:0,cd:25,cost:8,value:0,tip:'Talent ability. Cleanse roots, snares and control.'},pala_judgement:{name:'Judgement',icon:'⚖️',type:'damage',school:'holy',range:24,cast:0,cd:16,cost:10,value:165,tip:'Talent ability. Ranged holy damage increased by 10%. On hit it restores 8 mana and heals nearby allies for 101 after the 40% healing buff, helping Paladin recover resources while playing aggressively.'}},
 shadow:{shadow_sap:{name:'Sap',icon:'😵',type:'blind',school:'shadow',range:18,cast:0,cd:32,cost:18,value:4,tip:'Talent ability. Prevent an enemy from acting for 4 sec, creating a clean setup window. Damage breaks the effect.'},shadow_shadowstep:{name:'Vendetta',icon:'🎯',type:'vendetta',school:'shadow',range:24,cast:0,cd:45,cost:6,value:0,tip:'Off-GCD mark for 8 sec. No flat damage bonus. During Vendetta, your Garrote, Internal Bleeding and rogue poisons/bleeds tick faster on the marked target.'},shadow_crimson_vial:{name:'Crimson Vial',icon:'🧪',type:'heal',school:'shadow',range:0,cast:0,cd:28,cost:0,value:185,tip:'Talent ability. Instant self-heal defensive.'},shadow_gouge:{name:'Gouge',icon:'👁️',type:'gouge',school:'shadow',range:5,cast:0,cd:24,cost:16,value:2,tip:'Gouge the eyes of a nearby enemy, preventing actions for 2 sec. Damage can break the effect.'}},
 wind:{wind_tiger_rush:{name:'Tiger Rush',icon:'🐅',type:'leap',school:'wind',range:17,cast:0,cd:18,cost:22,value:128,tip:'Talent ability. Leap to the target and strike, giving Windwalker an additional reconnect tool.'},wind_karma:{name:'Touch of Karma',icon:'☯️',type:'monkDefensive',school:'wind',range:0,cast:0,cd:42,cost:0,value:0,tip:'Talent ability. Defensive martial stance for surviving pressure while staying aggressive.'}}
};

Object.assign(TALENT_UNLOCKED_ABILITIES.flame,{
 flame_dragon_breath:{name:'Dragon Breath',icon:'🐉',type:'blind',school:'fire',range:8,cast:0,cd:35,cost:14,value:3,tip:'Talent ability. Short-range disorient for setup or peel. Uses its own disorient DR and does not place Polymorph on diminishing returns.'},
 flame_molten_armor:{name:'Molten Armor',icon:'🪨',type:'shieldSelf',school:'fire',range:0,cast:0,cd:38,cost:8,value:260,tip:'Talent ability. Shield yourself to survive swaps without adding extra burst.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.warrior,{
 war_heroic_leap:{name:'Bladestorm',icon:'🌪️',type:'bladestorm',school:'physical',range:0,cast:0,cd:42,cost:20,value:80,tip:'Talent ability. Channel for 4 sec while spinning with your weapon and dealing repeated AoE damage. Enemies caught in the storm are slowed by 60%. You cannot use other abilities during Bladestorm, but pressing Bladestorm again cancels it early. Immune to stuns, roots and slows during the storm.'},
 war_disarm:{name:'Warbreaker',icon:'🪓',type:'warbreaker',school:'physical',range:4.5,cast:0,cd:30,cost:18,value:115,tip:'Talent ability. Strike for 115 damage and empower only your next Mortal Swing by 30% for up to 10 sec. That Mortal Swing consumes the buff and triggers three alternating Slicing Winds at a measured pace, each dealing 60% of one Mortal Swing.'}
,war_victory_rush:{name:'Victory Rush',icon:'🏆',type:'victoryRush',school:'physical',range:4.5,cast:0,cd:18,cost:10,value:34,healValue:185,tip:'Talent ability. Strike an enemy for light damage and heal yourself. If Shield Wall was pressed recently, the next Victory Rush consumes the proc and heals 60% more.'}});
Object.assign(TALENT_UNLOCKED_ABILITIES.storm,{
 storm_thunderstep:{name:'Thunderstep',icon:'👣',type:'push',school:'storm',range:0,cast:0,cd:26,cost:10,value:0,tip:'Talent ability. Knock back a nearby enemy or reposition if nobody is close.'},
 storm_mana_well:{name:'Mana Well',icon:'💧',type:'buff',school:'storm',range:0,cast:0,cd:40,cost:0,value:0,tip:'Talent ability. Defensive sustain node; restores resource and supports longer games.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.soul,{
 soul_shadowfury:{name:'Shadowfury',icon:'🌑',type:'groundStun',school:'shadow',range:20,cast:0,cd:36,cost:0,value:42,radius:4.5,duration:3,tip:'Choose a ground location. Enemies in the area take 42 Shadow damage and are stunned for 3 sec. Your next Pandemic Bloom deals 20% more damage.'},
 soul_dark_pact:{name:'Dark Pact',icon:'🛡️',type:'shieldSelf',school:'shadow',range:0,cast:0,cd:40,cost:0,value:300,tip:'Talent ability. Shield yourself to survive swaps while your damage over time ramps.'},
 soul_undying_resolve:{name:'Undying Resolve',icon:'🟣',type:'undyingResolve',school:'shadow',range:0,cast:0,cd:55,cost:0,value:0,tip:'Talent ability. Reduce all damage taken by 50% for 5 sec. Use it when enemy burst is committed or your healer is controlled.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.sage,{
 sage_natures_grasp:{name:'Nature’s Grasp',icon:'🌿',type:'root',school:'nature',range:24,cast:0,cd:28,cost:10,value:3.5,tip:'Talent ability. Root an enemy to peel melee pressure.'},
 sage_rejuvenating_gust:{name:'Nature Swiftness',icon:'🌿',type:'natureSwiftness',school:'nature',range:0,cast:0,cd:40,cost:0,value:0,tip:'Talent ability. For 8 sec, choose one empowered cast: use Renewal Tide immediately even while it is on cooldown, or cast Lullaby Bloom instantly even while it is on cooldown. Using either spell consumes Nature Swiftness.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.pala,{
 pala_word_of_glory:{name:'Word of Glory',icon:'📜',type:'heal',school:'holy',range:28,cast:0,cd:16,cost:10,value:264,tip:'Talent ability. Instant single-target emergency heal for 264 health after the 20% buff.'},
 pala_blinding_light:{name:'Blinding Light',icon:'✨',type:'blind',school:'holy',range:16,cast:0,cd:45,cost:12,value:5,tip:'Disorient an enemy for 5 sec. Breaks on damage, follows incapacitate diminishing returns and has a 45 sec cooldown.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.shadow,{
 shadow_shiv:{name:'Shiv',icon:'🗡️',type:'shiv',school:'physical',range:3.3,cast:0,cd:12,cost:16,value:36,tip:'Off-GCD talent ability. Slow the enemy by 65% for 4 sec and increase poison damage dealt to that target by 30% for the same duration.'},
 shadow_cloak:{name:'Cloak of Shadows',icon:'🧥',type:'shieldSelf',school:'shadow',range:0,cast:0,cd:42,cost:0,value:270,tip:'Talent ability. Shield yourself against caster pressure.'},
 shadow_garrote:{name:'Garrote',icon:'🩸',type:'dot',school:'physical',range:4.4,cast:0,cd:14,cost:18,value:118,tip:'Off-GCD talent ability. Apply an immediate strike and a heavy bleed. Garrote ticks faster during Vendetta.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.wind,{
 wind_tigereye_brew:{name:'Tigereye Brew',icon:'🍺',type:'tigereyeBrew',school:'wind',range:0,cast:0,cd:1,cost:0,value:0,tip:'Talent ability. Stack up to 6. Consuming 2 stacks grants 10% damage and healing, 4 stacks grants 20%, and 6 stacks grants 30% for 6 sec.'},

 wind_leg_sweep:{name:'Leg Sweep',icon:'🦵',type:'windStun',school:'wind',range:5.5,cast:0,cd:38,cost:18,value:62,tip:'Talent ability. Area stun for coordinated kill attempts.'},
 wind_chi_wave:{name:'Chi Wave',icon:'🟢',type:'heal',school:'wind',range:24,cast:0,cd:16,cost:10,value:150,tip:'Talent ability. Light utility heal for emergency stabilisation.'}
});

delete TALENT_UNLOCKED_ABILITIES.flame.flame_inferno_wave;Object.assign(TALENT_UNLOCKED_ABILITIES.flame,{flame_meteor_spear:{name:'Living Bomb',icon:'💣',type:'livingBomb',school:'fire',range:24,cast:0,cd:16,cost:3,value:18,explodeValue:190,tip:'Apply a dispellable 6 sec fire DoT. If not cleansed, it explodes for heavy fire damage.'},flame_molten_armor:{name:'Fire Shield',icon:'🛡️',type:'flameShield',school:'fire',range:0,cast:0,cd:38,cost:2,value:260,tip:'Shield yourself. Attackers who hit the shield take fire damage and a short burn.'},flame_combustion:{name:'Combustion',icon:'🔥',type:'combustion',school:'fire',range:0,cast:0,cd:55,cost:0,value:0,tip:'Ignite yourself for 8 sec, gaining 30% crit chance and 15% faster casts.'}});Object.assign(TALENT_UNLOCKED_ABILITIES.shadow,{shadow_sap:{name:'Crimson Vial',icon:'🧪',type:'crimsonVial',school:'shadow',range:0,cast:0,cd:28,cost:0,value:.01,tip:'Restore 1% maximum health every 1 sec for 10 sec. This healing ignores dampening.'},shadow_crimson_vial:{name:'Evasion',icon:'💨',type:'evasion',school:'shadow',range:0,cast:0,cd:38,cost:0,value:0,tip:'50% dodge chance against melee for 8 sec.'},shadow_cloak:{name:'Cloak of Shadows',icon:'🧥',type:'cloak',school:'shadow',range:0,cast:0,cd:42,cost:0,value:180,tip:'For 5 sec, remove and become immune to damage-over-time effects and non-physical spells. Physical attacks, Bladestorm and Fists of Fury can still damage you.'},shadow_shadowstep:{name:'Vendetta',icon:'🎯',type:'vendetta',school:'shadow',range:24,cast:0,cd:45,cost:6,value:0,tip:'Off-GCD mark for 8 sec. No flat damage bonus. During Vendetta, your Garrote, Internal Bleeding and rogue poisons/bleeds tick faster on the marked target.'},shadow_garrote:{name:'Garrote',icon:'🩸',type:'dot',school:'physical',range:4.4,cast:0,cd:14,cost:8,value:120,tip:'Strike hard and apply a significantly stronger 8 sec bleed. Garrote does not silence. It ticks twice as fast during Vendetta and can be used immediately between other abilities.'}});Object.assign(TALENT_UNLOCKED_ABILITIES.storm,{storm_mana_well:{name:'Totem Mastery',icon:'🪧',type:'totemMastery',school:'storm',range:0,cast:0,cd:45,cost:0,value:0,tip:'Place small totems granting 3% damage, healing, shield and proc chance.'},storm_thunderstep:{name:'Stormkeeper',icon:'🔱',type:'stormkeeper',school:'storm',range:0,cast:1.5,cd:40,cost:4,value:0,tip:'1.5 sec cast. Self-cast with no target requirement. Grants 3 free instant Arc Sparks. Only Arc Spark is empowered: each free Arc Spark costs 0 mana, casts instantly, uses a 0.25 sec mini-GCD and deals 10% increased damage until all 3 charges are spent.'},storm_grounding_aegis:{name:'Frost Shock',icon:'❄️',type:'frostShock',school:'storm',range:24,cast:0,cd:0,cost:1,value:38,tip:'Deal 38 Frost damage, slow the target by 25% for 8 sec, and make your Arc Spark and Forked Current deal 15% more damage to that target while Frost Shock remains active.'},storm_chain_spark:{name:'Healing Surge',icon:'🔗',type:'heal',school:'storm',range:28,cast:1.5,cd:12,cost:10,value:340,tip:'Cast a strong surge that restores roughly 20% of a geared ally’s health before dampening.'}});Object.assign(TALENT_UNLOCKED_ABILITIES.wind,{wind_tigers_lust:{name:"Tiger's Lust",icon:'🐯',type:'tigersLust',school:'wind',range:0,cast:0,cd:25,cost:0,value:0,tip:"Talent ability. Remove snares and roots, then gain 70% movement speed for 4 sec."},wind_tiger_rush:{name:'Strike of the Windlord',icon:'🌩️',type:'windlordStrike',school:'wind',range:4.0,cast:0,cd:15,cost:8,value:265,tip:'15 sec cooldown. Release a concentrated violet-and-gold wind strike for 265 damage. Resets Cloudstep Kick, empowers its next hit by 15%, and transforms your next Zephyr Palm into Rising Sun Kick.'},wind_disabling_reach:{name:'Disabling Reach',icon:'🪢',type:'slow',school:'wind',range:8,cast:0,cd:6,cost:3,value:24,tip:'Utility strike with 8m reach: deal light damage and apply a 60% movement snare for up to 4 sec. Its duration follows root diminishing returns.'},wind_chi_burst:{name:'Cyclone Barrage',icon:'🌪️',type:'monkFinisher',school:'wind',range:3.5,cast:0,cd:8,cost:24,value:82,tip:'Talent ability. Melee finisher. If Tempest Flow is active, consumes it for a heavy Cyclone Combo. Fists of Fury is now separate and no longer requires Cyclone first.'},wind_karma:{name:'Touch of Karma',icon:'☯️',type:'karma',school:'wind',range:0,cast:0,cd:42,cost:0,value:0,tip:'For 4 sec, reflect incoming damage back to attackers and take 20% less damage.'}});delete TALENT_UNLOCKED_ABILITIES.wind.wind_leg_sweep;delete TALENT_UNLOCKED_ABILITIES.wind.wind_chi_wave;delete TALENT_UNLOCKED_ABILITIES.wind.wind_paralysis;
Object.assign(TALENT_UNLOCKED_ABILITIES.warrior,{
 war_execute_strike:{name:'Stormbolt',icon:'🔮',type:'stormbolt',school:'physical',range:22,cast:0,cd:25,cost:15,value:3,tip:'Hurl a violet storm bolt up to 22m. The missile stuns for 3 sec on impact and follows normal stun diminishing returns.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.storm,{
 storm_chain_spark:{name:'Healing Surge',icon:'🔗',type:'heal',school:'storm',range:28,cast:1.5,cd:12,cost:10,value:340,tip:'Cast a strong surge that restores roughly 20% of a geared ally’s health before dampening.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.wind,{
 wind_tigers_lust:{name:"Tiger's Lust",icon:'🐯',type:'tigersLust',school:'wind',range:0,cast:0,cd:25,cost:0,value:0,tip:'Remove snares and roots, then gain 60% movement speed for 4 sec.'},
 wind_chi_burst:{name:'Touch of Death',icon:'☠️',type:'touchOfDeath',school:'wind',range:4,cast:0,cd:35,cost:20,value:5,tip:'Mark the target for 5 sec. Records the actual damage dealt by your damaging spells, then explodes for 30% of that damage.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.flame,{
 flame_phoenix_guard:{name:'Alter Time',icon:'⏳',type:'defensive',school:'arcane',range:0,cast:0,cd:0,cost:0,value:0,tip:'Save your current location and health for 5 sec. Recast during that window—or let it expire—to return to the saved state. 1 min cooldown begins when you return.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.storm,{
 storm_mana_well:{name:'Totem Mastery',icon:'🪧',type:'totemMastery',school:'storm',range:0,cast:0,cd:45,cost:0,value:0,tip:'Place small totems granting 5% damage, healing, shield and proc chance. Flame Shock deals 10% extra damage while active. Costs 0 Mana.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.storm,{
 storm_static_field:{name:'Healing Stream Totem',icon:'💧',type:'healingStreamTotem',school:'storm',range:0,cast:0,cd:30,cost:14,value:90,tip:'Summon a killable Healing Stream Totem with 280 health at your feet for 10 sec. It heals group members within 18m for 90 every 2 sec.'},
 storm_chain_spark:{name:'Healing Surge',icon:'🔗',type:'heal',school:'storm',range:28,cast:.75,cd:12,cost:10,value:340,tip:'0.75 sec cast. Restore 340 health to yourself or an ally before gear, critical strikes and dampening.'},
 storm_thunderstep:{name:'Stormkeeper',icon:'🔱',type:'stormkeeper',school:'storm',range:0,cast:1.5,cd:40,cost:4,value:0,tip:'1.5 sec cast. Grants 3 free instant Arc Sparks. These casts cost no mana, deal 10% increased damage and have no mini-GCD. The first empowered Arc Spark on an unmarked target creates the 8m Lightning Rod cloud for 6 sec.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.flame,{
 flame_combustion:{name:'Combustion',icon:'🔥',type:'combustion',school:'fire',range:0,cast:0,cd:55,cost:0,value:0,tip:'Ignite yourself for 8 sec, gaining 80% critical strike chance and 15% faster casts.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.soul,{
 soul_summon_infernal:{name:'Summon Infernal',icon:'🔥',type:'summonInfernal',school:'shadow',range:22,cast:0,cd:80,cost:12,value:90,radius:5,duration:10,tip:'Choose a ground location within 22m. An Infernal crashes down, dealing 90 Shadow damage and stunning enemies within 5m for 2 sec. Enemies struck by its landing or Immolation take 10% increased damage for 10 sec. The killable Infernal serves you for 10 sec, deals 50 damage to nearby enemies every 2 sec and restores 4 mana every 1 sec.'},
 soul_void_mend:{name:'Chaos Bolt',icon:'🟢',type:'chaosBolt',school:'shadow',range:25,cast:1.6,cd:10,cost:6,value:510,tip:'Cast a devastating bolt of chaos that deals 510 Shadow damage. Chaos Bolt always critically strikes, and your Critical Strike chance further increases its damage. Learning Chaos Bolt replaces Unstable Affliction and transforms Creeping Torment into Immolate. Every Essence Siphon tick reduces this cooldown by 3 sec.'},
 soul_dark_pact:{name:'Dark Pact',icon:'🛡️',type:'shieldSelf',school:'shadow',range:0,cast:0,cd:40,cost:0,value:.30,percentShield:true,tip:'Surround yourself with a shadow barrier that absorbs damage equal to 30% of your maximum health for 6 sec. Dark Pact does not grant Soul Barrier’s interrupt immunity. Barrier Rites further increases the amount absorbed.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.sage,{
 sage_natures_grasp:{name:'Nature’s Grasp',icon:'🌿',type:'root',school:'nature',range:24,cast:0,cd:25,cost:10,value:5,tip:'Root an enemy in place for up to 5 sec. Repeated roots have shorter durations.'}
});
Object.assign(TALENT_UNLOCKED_ABILITIES.pala,{
 pala_guardian_angel:{name:'Guardian Angel',icon:'👼',type:'guardianAngel',school:'holy',range:28,cast:0,cd:45,cost:10,value:6,tip:'Summon a killable Val’kyr with 124 health for 6 sec. It follows your chosen ally and keeps them immune to damage while it lives.'},
 pala_freedom:{name:'Blessing of Freedom',icon:'🪽',type:'freedom',school:'holy',range:28,cast:0,cd:25,cost:8,value:5,tip:'Bless yourself or an ally for 5 sec, removing and preventing roots and movement slows while increasing movement speed by 30%.'}
});

// Chaos Bolt is a two-spell specialisation conversion: Unstable Affliction becomes
// Chaos Bolt, while Creeping Torment becomes the faster fire damage-over-time cast.
const CHAOS_IMMOLATE_ABILITY={name:'Immolate',icon:'🔥',type:'immolate',school:'fire',range:25,cast:1.35,cd:0,cost:2,value:86,dotValue:35,tip:'Burn an enemy for 86 Fire damage immediately and another 280 Fire damage over 8 sec. Immolate has a 1.35 sec cast time and no cooldown. Essence Siphon channels 1 sec faster against your Immolated target.'};
const soulFear=AB.soul.find(a=>a.name==='Fear');if(soulFear)soulFear.cd=6;
const soulSiphon=AB.soul.find(a=>a.name==='Essence Siphon');if(soulSiphon)soulSiphon.tip='Channel for 2.5 sec, draining the target every 0.5 sec and healing yourself. Soul Scar and Creeping Torment strengthen each tick. Press Essence Siphon again to stop the channel early.';
Object.assign(TALENT_UNLOCKED_ABILITIES.shadow,{
 shadow_gouge:{name:'Gouge',icon:'👁️',type:'gouge',school:'shadow',range:5,cast:0,cd:24,cost:16,value:3,tip:'Gouge the eyes of a nearby enemy, preventing them from moving or acting for 3 sec. Any direct or periodic damage can end Gouge early. Learning Gouge also increases all Shadowblade damage by 10%.'},
 shadow_sap:{name:'Crimson Vial',icon:'🧪',type:'crimsonVial',school:'shadow',range:0,cast:0,cd:28,cost:0,value:.015,tip:'Drink a Crimson Vial and restore 1.5% of your maximum health every 1 sec for 10 sec, for 15% total health. This healing ignores dampening.'},
 shadow_crimson_vial:{name:'Evasion',icon:'💨',type:'evasion',school:'shadow',range:0,cast:0,cd:38,cost:0,value:0,tip:'For 8 sec, gain a 70% chance to dodge incoming melee attacks. Evasion does not protect against spells or damage-over-time effects.'},
 shadow_shadowstep:{name:'Vendetta',icon:'🎯',type:'vendetta',school:'shadow',range:24,cast:0,cd:60,cost:6,value:0,tip:'Mark an enemy for 10 sec. Your Garrote, Internal Bleeding, poisons and bleeds tick twice as fast on that target. Vendetta does not add a separate flat damage bonus.'}
});

// Healer mana pass: costs now sit at 95% of their original values, including
// learned talent spells. This is another ten-point increase from 85%.
for(const cls of ['sage','pala','disc']){
 (AB[cls]||[]).forEach(a=>{if(a.cost>0)a.cost=Math.max(.5,Math.round(a.cost*.95*10)/10);});
 Object.values(TALENT_UNLOCKED_ABILITIES[cls]||{}).forEach(a=>{if(a.cost>0)a.cost=Math.max(.5,Math.round(a.cost*.95*10)/10);});
}

// Spell descriptions are written as player instructions, not patch notes. The
// renderer also adds a consistent targeting sentence to every spell so a new
// player can tell what a button expects before pressing it.
const ABILITY_TOOLTIP_REWRITES={
 'Ember Lance':'Instantly strike an enemy for 158 Fire damage, increased by 30% if the target is burning. After Meteor lands, your next Ember Lance has its cooldown reset, deals 15% more damage and can be fired immediately between your other abilities.',
 'Frostfire Nova':'Deal 36 damage to nearby enemies, root them in place for 4 sec and then slow them by 60% for 6 sec. You can cast it while moving and immediately between your other abilities.',
 'Blazing Step':'Blink 15m in your movement direction and leave a damaging ember trail. You can use it immediately between your other abilities, including during Prism Hex or Cinder Bolt without interrupting that cast.',
 'Prism Hex':'Transform an enemy into a harmless sheep for up to 7 sec. Damage breaks the effect, and repeated incapacitating effects on the same target have shorter durations.',
 'Counterflare':'Interrupt an enemy cast and prevent spells from that school for 3 sec. A successful interrupt restores 20 mana and makes your next two Cinder Bolts instant and 20% stronger. You can use it while moving and immediately between your other abilities.',
 'Ice Block':'Remove control effects and encase yourself in ice for up to 8 sec. While encased, you are immune to damage and heal for 20% of your maximum health, but cannot attack. Press Ice Block again to end it early. It can be activated while controlled and immediately between your other abilities.',
 'Shadow Kick':'Kick an enemy in melee range for 36 damage. If they are casting, the kick interrupts them and prevents spells from that school for 3 sec. You can use it immediately between your other abilities.',
 'Skybreaker Pulse':'Deal 55 Storm damage to nearby enemies, stun them for 4 sec and ready one Volcanic Eruption. Repeated stuns on the same target have shorter durations. You can use it while moving and immediately between your other abilities.',
 'Wind Shear':'Interrupt an enemy cast from up to 25m away and prevent spells from that school for 2.5 sec. A successful interrupt activates Aftershock if learned. You can use it immediately between your other abilities.',
 'Flame Shock':'Burn an enemy for 34 Fire damage each second for 12 sec. It has no cooldown and can be maintained on several enemies at once.',
 'Cloudstep Kick':'Kick an enemy in melee range for 127 damage. Every 20 sec it becomes Cloudstep Dash, allowing you to leap from up to 17m away and deal 20% more damage.',
 'Soul Scar':'Mark an enemy with soul decay, dealing about 32 Shadow damage each second for 15 sec. Soul Scar strengthens each tick of Essence Siphon and can activate Curse Weaving when reapplied.',
 'Divine Steed':'Summon your combat mount for 3 sec and increase your movement speed by 65%. You can activate it immediately between your other abilities.',
 'Spirit Blossom':'Plant a healing tree for 9 sec. Each second it heals allies within 6m for about 48 health and grants them 23 absorption.',
 'Pain Suppression':'Reduce an ally’s damage taken by 60% for 5 sec. Use it before or during heavy enemy attacks. You can activate it immediately between your other abilities.',
 'Purify':'Remove one Polymorph, Sleep, Blind, Fear, Root or movement-slowing effect from yourself or an ally.',
 'Psychic Scream':'Fear visible enemies within 8m for up to 4 sec. Damage can break the fear, and enemies behind a pillar are unaffected.',
 'G\'Hanir, the Mother Tree':'For 7 sec, Blooming Echo and Rejuvenate heal 50% more and tick 50% faster. Their durations do not become shorter, so the faster ticks add extra healing.',
 'Meteor':'Choose a location within 25m. After a short warning, a meteor lands for 205 Fire damage to enemies in a 5.2m area and burns them for 5 sec. When it lands, your next Ember Lance deals 15% more damage, has its cooldown reset and can be fired between your other abilities.',
 'Shadowfury':'Choose a location within 20m. Enemies in the 4.5m circle take 42 Shadow damage and are stunned for 3 sec. Casting Shadowfury also makes your next Pandemic Bloom deal 20% more damage for 8 sec.',
 'Summon Infernal':'Choose a location within 22m. An Infernal crashes into the 5m area, dealing 90 Shadow damage and stunning enemies for 2 sec. Enemies struck by its landing or Immolation take 10% increased damage for 10 sec. It remains for 10 sec with 25% of your maximum health, chases the nearest enemy, damages enemies within 8m for 50 every 2 sec and restores 4 mana every second. Enemies can target and destroy it.',
 'Umbral Pounce':'Leap to an enemy and strike for 90 damage. For 1.5 sec after landing, you have a 50% chance to dodge each incoming melee attack. This can be used immediately between your other abilities.',
 'Evasion':'For 8 sec, you have a 70% chance to dodge each incoming melee attack. It does not protect against spells or damage-over-time effects.',
 'Renewal Tide':'Instantly restore 782 health to yourself or an ally. Each cast also empowers your next Verdant Mend by 150%, making that heal 2.5 times as strong.',
 'Verdant Mend':'After a 1.5 sec cast, restore 202 health to yourself or an ally. If Renewal Tide has empowered this spell, the bonus is consumed and Verdant Mend heals for 150% more.',
 'Holy Shock':'Instantly heal an ally for 188 health or damage an enemy for 126 Holy damage. A critical Holy Shock grants Infusion of Light, making your next Holy Light cast 50% faster and refund mana.',
 'Holy Light':'Restore 270 health to yourself or an ally. Infusion of Light makes the next cast 50% faster and refunds 6 mana when the cast begins.',
 'Power Shield':'Shield yourself or an ally and apply Atonement. Damage dealt by Smite, Penance and Solace then heals every ally carrying your Atonement.',
 'Shadow Mend':'Restore health to yourself or an ally, apply Atonement and briefly reduce the target’s incoming damage. The cast completes without restarting itself if the target becomes safer during the cast.',
 'Ultimate Radiance':'Heal every living ally, apply Atonement to them and empower your next Penance. The empowered Penance channels 30% faster and deals and converts 15% more healing.',
 'Penance':'Channel three bolts while moving. Against an enemy, each bolt deals damage and heals all allies with your Atonement. On an ally, each bolt directly heals that ally.',
 'Smite':'Deal Holy damage to an enemy and convert part of that damage into healing for every ally with your Atonement.',
 'Solace':'Deal Holy damage, restore mana and heal every ally with your Atonement. Use it while moving to preserve mana and positioning.',
 'Stormkeeper':'After a 1.5 sec cast, your next three Arc Sparks are free, instant and deal 10% more damage. The first empowered Arc Spark creates Lightning Rod on enemies in an 8m area for 6 sec; Arc Spark and Forked Current deal 20% more damage to marked enemies.',
 'Arc Spark':'Deal Storm damage to an enemy. Each normal cast rolls for Storm Surge; failed rolls increase the next chance. Storm Surge restores mana and readies two Tempest Bolts plus an empowered Forked Current.',
 'Forked Current':'Strike visible enemies with lightning. During Volcanic Overload it deals 35% more damage, launches three Lava Bursts at each visible enemy and restores mana. It deals 20% more damage to enemies marked by your Lightning Rod.',
 'Warbreaker':'Strike an enemy for 115 damage and empower your next Mortal Swing by 30% for up to 10 sec. That Mortal Swing consumes the effect and releases three Slicing Winds, each dealing 60% of Mortal Swing damage.',
 'Sharpen Blade':'Prepare your next Mortal Swing. When it hits, the target receives 40% less healing for 3 sec and you restore 3% maximum health each second for 3 sec; this personal healing ignores dampening.',
 'Intercept':'Charge to an ally and redirect all damage they would take to you for 4 sec. Damage redirected this way can still be reduced by your own defensive effects.',
 'Shield Wall':'Immediately reduce all damage taken by 60% for 6 sec, but deal 25% less damage while protected. It also empowers your next Victory Rush to heal 60% more.',
 'Victory Rush':'Strike an enemy and heal yourself. If Shield Wall has prepared Victory Rush, this cast consumes that preparation and heals 60% more.',
 'Mortal Swing':'Strike an enemy in melee range. Pummel can empower the next Mortal Swing by 30%; Warbreaker can add another 30% and trigger Slicing Winds; Sharpen Blade can make the hit reduce healing received.',
 'Pummel':'Interrupt an enemy cast and lock that spell school for 3 sec. A successful interrupt empowers your next Mortal Swing by 30%, plus 2% per Pummel Chain rank. This can be used immediately between your other abilities.',
 'Bladestorm':'Spin for 4 sec while moving, repeatedly damaging and slowing nearby enemies. You are immune to stuns, roots and slows during the channel. Press Bladestorm again to cancel it. Every hit can trigger Shadowmoon Soul Fragments.',
 'Living Bomb':'Apply a removable 6 sec fire effect. If it is not cleansed before expiring, it explodes for heavy area damage. It can be used immediately between your other abilities.',
 'Alter Time':'Save your health and location for 5 sec. Press Alter Time again, or let the effect expire, to return to that saved state. Its 60 sec cooldown begins when you return.',
 'Combustion':'For 8 sec, gain 80% critical strike chance and cast spells 15% faster. It can be activated immediately without delaying another ability.',
 'Cloak of Shadows':'Remove damage-over-time effects and become immune to new damage-over-time effects and non-physical spells for 5 sec. Physical melee attacks, Bladestorm and Fists of Fury can still hit you.',
 'Vendetta':'Mark an enemy for 10 sec. Your Garrote, Internal Bleeding, poisons and bleeds tick twice as fast on that target. Vendetta does not add a separate flat damage bonus.',
 'Nature Swiftness':'For 8 sec, choose one empowered spell: use Renewal Tide even if it is on cooldown, or cast Lullaby Bloom instantly even if it is on cooldown. The first chosen spell consumes Nature Swiftness.',
 'G\'Hanir':'For 7 sec, Blooming Echo and Rejuvenate heal 50% more and tick 50% faster without shortening their remaining duration.',
 'Touch of Death':'Mark an enemy for 5 sec and record the damage your spells deal to that target. When the mark expires, it deals 30% of the recorded amount. This can be used immediately between your other abilities.',
 'Whirling Dragon Punch':'Become usable while Fists of Fury is on cooldown. Leap into a spinning area strike; it can be used immediately between your other abilities.',
 'Blessing of Sacrifice':'Redirect all damage taken by an ally to you for 6 sec. This also grants Avenging Wings, increasing your healing and damage while active.',
 'Divine Toll':'Fire three Holy Shocks at the selected ally or enemy. Every shot can critically heal or damage and can grant Infusion of Light.',
 'Cauterize':'Passive: the first lethal hit leaves you at 30% health and grants 50% movement speed. After 5 sec you are defeated regardless of healing. This can happen only once per match.'
 ,'Fire Shield':'Shield yourself for 260 damage. Enemies that strike the shield take Fire damage and begin burning. Using Fire Shield also activates Overheat if learned.'
 ,'Dragon Breath':'Breathe fire at a nearby enemy, disorienting them for 3 sec. Damage breaks the effect; repeated disorienting effects on the same target have shorter durations.'
 ,'Stormbolt':'Hurl a violet bolt at an enemy from up to 22m away. The missile stuns for 3 sec when it reaches the target; repeated stuns have shorter durations.'
 ,'Avatar':'Remove an active root and increase all damage you deal by 18% for 10 sec. Avatar does not make you immune to roots applied afterwards. You can activate it immediately between your other abilities.'
 ,'Volcanic Eruption':'Consume the charge prepared by Skybreaker Pulse to deal 353 Storm damage, then launch two smaller Lava Bursts. The ability is unavailable until Skybreaker Pulse prepares it. You can cast it immediately between your other abilities.'
 ,'Grounding Aegis':'Shield yourself for 320 damage so you can continue casting through enemy pressure.'
 ,'Healing Stream Totem':'Summon a totem with 280 health at your feet for 10 sec. Every 2 sec it heals group members within 18m for 90 health. Enemies can target and destroy the totem.'
 ,'Healing Surge':'After a 0.75 sec cast, restore 340 health to yourself or an ally before gear bonuses, critical strikes and dampening are applied. The cooldown begins only after a successful completed cast.'
 ,'Totem Mastery':'Place empowering totems for 20 sec. While active, you deal 5% more damage, heal and shield for 5% more, gain 5% Storm Surge chance, and Flame Shock deals 10% more damage.'
 ,'Frost Shock':'Deal 38 Frost damage and slow the enemy by 25% for up to 3 sec; repeated roots or snares shorten the slow. The Frost Shock mark remains for 8 sec, increasing your Arc Spark and Forked Current damage against that enemy by 15%.'
 ,'Pandemic Bloom':'Instantly deal 274 Shadow damage to an enemy. Shadowfury empowers your next Pandemic Bloom by 20% for 8 sec.'
 ,'Chaos Bolt':'After a 1.6 sec cast, launch a devastating bolt of chaos for 510 Shadow damage. Chaos Bolt always critically strikes, and your Critical Strike chance further increases its damage. Learning it replaces Unstable Affliction and transforms Creeping Torment into Immolate. Every Essence Siphon tick reduces its 10 sec cooldown by 3 sec.'
 ,'Immolate':'After a 1.35 sec cast, burn an enemy for 86 Fire damage immediately and another 280 Fire damage over 8 sec. Immolate has no cooldown and makes Essence Siphon channel 1 sec faster against that target.'
 ,'Essence Siphon':'Channel for 2.5 sec, damaging the enemy and healing yourself every 0.5 sec. Soul Scar and Creeping Torment strengthen every tick. Press Essence Siphon again to stop the channel early.'
 ,'Mortal Horror':'Fear an enemy for up to 3.5 sec and immediately heal yourself for 20% maximum health before dampening. Your periodic damage does not break this fear, but direct damage can.'
 ,'Dark Pact':'Shield yourself for 30% of your maximum health for 6 sec. Dark Pact does not grant Soul Barrier’s interrupt immunity. Barrier Rites increases the amount absorbed by 3% per rank.'
 ,'Undying Resolve':'Reduce all damage taken by 50% for 5 sec. Use it when the enemy commits major attacks or your healer cannot help you.'
 ,'Ironbark':'For 6 sec, reduce damage taken by yourself or an ally by 20% and increase all healing they receive by 20%.'
 ,'Nature’s Grasp':'Root an enemy in place for up to 5 sec. The target can still cast, and repeated roots have shorter durations.'
 ,'Rejuvenate':'Restore 90 health immediately, then 28 health each second for 12 sec. Reapplying refreshes only Rejuvenate; Blooming Echo remains active separately.'
 ,'Guardian Angel':'Summon a Val’kyr with 124 health for 6 sec. It follows you or the chosen ally and makes that champion immune to all damage while the Val’kyr remains alive. Enemies can target and destroy it.'
 ,'Blessing of Freedom':'Bless yourself or an ally for 5 sec, removing and preventing roots and movement slows while increasing movement speed by 30%.'
 ,'Judgement':'Deal 165 Holy damage to an enemy, restore 8 mana and heal nearby allies for 101 health.'
 ,'Word of Glory':'Instantly restore 264 health to yourself or an ally. Use it for emergency recovery when there is no time to cast Holy Light.'
 ,'Blinding Light':'Disorient an enemy for 5 sec. Damage breaks the effect, and repeated incapacitating effects on the same target have shorter durations.'
 ,'Crimson Vial':'Drink a Crimson Vial and restore 1.5% of your maximum health every 1 sec for 10 sec, for 15% total health. This healing ignores dampening.'
 ,'Gouge':'Gouge the eyes of a nearby enemy, preventing them from moving or acting for 3 sec. Any direct or periodic damage can end Gouge early. Learning Gouge also increases all Shadowblade damage by 10%.'
 ,'Shiv':'Strike an enemy in melee range for 36 damage and slow them by 65% for 4 sec. Your poison damage against that target is increased by 30% for 8 sec.'
 ,'Viper Cut':'Strike an enemy for 70 damage and poison them for 8 sec. Consumes Venom Edge for a stronger initial strike and stronger poison.'
 ,'Ribbreaker':'Strike an enemy for 35 damage and stun them for 4 sec. The hit empowers your next Night Slash into Eviscerate for 45% more damage. With the Vendetta branch learned, Ribbreaker also applies Internal Bleeding for 6 sec. After Smoke Veil, it deploys Smoke Bomb.'
 ,'Garrote':'Strike an enemy and apply a strong bleed for 8 sec. Garrote does not silence. It ticks twice as fast against a target marked by Vendetta and can be used immediately between your other abilities.'
 ,'Strike of the Windlord':'Strike an enemy for 265 damage, reset Cloudstep Kick, empower its next hit by 15% and transform your next Zephyr Palm into Rising Sun Kick.'
 ,'Touch of Karma':'For 4 sec, each damaging hit you take deals 30% of the health damage back to its attacker and restores health equal to 50% of the health damage you took. A visible Karma icon appears above you for the duration.'
 ,'Tiger\'s Lust':'Remove roots and movement-slowing effects from yourself, then increase movement speed by 60% for 4 sec.'
 ,'Disabling Reach':'Strike an enemy from up to 8m for light damage and slow them by 60% for up to 4 sec.'
 ,'Tigereye Brew':'Passive: every two Zephyr Palms grant two stacks, up to six. Use Tigereye Brew to consume 2, 4 or 6 stacks and gain 10%, 20% or 30% increased damage and healing for 6 sec.'
};
const IMMEDIATE_ABILITY_TYPES=new Set(['interrupt','interruptProc','windInterrupt','shadowInterrupt','flameNova','iceBlock','pummel','reflect','warriorGuard','avatar','painSuppression','archangel','darkArchangel','angelicBody','natureSwiftness','touchOfDeath','whirlingDragonPunch','tigereyeBrew','sharpenBlade']);
const SELF_ABILITY_TYPES=new Set(['buff','dash','defensive','shieldSelf','push','healerEscape','natureSwiftness','undyingResolve','monkDefensive','fistsChannel','whirlingDragonPunch','ghanir','ultimateRadiance','discFade','discFear','archangel','darkArchangel','angelicBody','flameNova','paladinAoE','paladinGuard','paladinSteed','iceBlock','reflect','shout','warriorGuard','sharpenBlade','avatar','combustion','flameShield','evasion','cloak','crimsonVial','totemMastery','stormkeeper','tigereyeBrew','karma','bladestorm','tigersLust']);
const FRIENDLY_ABILITY_TYPES=new Set(['heal','hot','shield','spiritBlossom','ironbark','bigHeal','cleanse','freedom','guardianAngel','holyLight','sacrifice','intercept','bestowFaith','discShield','discMend','painSuppression']);
const AROUND_SELF_ABILITY_NAMES=new Set(['Skybreaker Pulse','Valley Sweep','Leg Sweep']);
function cleanAbilityText(text=''){
 return String(text).replace(/\b(?:Talent ability|Choice talent)\.\s*/gi,'').replace(/\bCosts?\s+\d+(?:\.\d+)?\s+(?:mana|energy)\.\s*/gi,'').replace(/\bNOW\b[:\s-]*/g,'').replace(/\bOff[ -]?(?:GCD|global)\.?\s*/gi,'').replace(/\bNo longer\b/gi,'Does not').replace(/\bDoTs?\b/g,'damage-over-time effects').replace(/\bHoTs?\b/g,'healing-over-time effects').replace(/\bAoE\b/g,'area').replace(/\bCC\b/g,'crowd control').replace(/\bDR\b/g,'diminishing returns').replace(/\bproc(?:s)?\b/gi,'triggered effect').replace(/\s{2,}/g,' ').trim();
}
function abilityTargetingText(a){
 if(['meteor','groundStun','summonInfernal'].includes(a.type))return 'Targeting: choose a point on the ground, then left-click to confirm; right-click or Escape cancels.';
 if(SELF_ABILITY_TYPES.has(a.type)||AROUND_SELF_ABILITY_NAMES.has(a.name)||a.range===0)return 'Target: yourself or the area around you.';
 if(FRIENDLY_ABILITY_TYPES.has(a.type))return a.type==='intercept'||a.type==='sacrifice'?'Target: a living ally other than yourself.':'Target: yourself or a living ally.';
 if(a.type==='holyShock'||a.type==='discPenance')return 'Target: a living ally to heal or an enemy to damage.';
 return 'Target: a living enemy.';
}
function playerFacingAbilityTooltip(a){
 if(!a)return'';
 let text=cleanAbilityText(ABILITY_TOOLTIP_REWRITES[a.name]||a.tip||'Use this ability for its listed effect.');
 const originallyImmediate=/Off[ -]?(?:GCD|global)/i.test(String(a.tip||''));
 if((originallyImmediate||IMMEDIATE_ABILITY_TYPES.has(a.type))&&!/between your other abilities/i.test(text))text+=' This can be used immediately between your other abilities.';
 const targeting=abilityTargetingText(a);
 return `${text}${/[.!?]$/.test(text)?'':'.'} ${targeting}`;
}
function refreshAbilityTooltips(){
 Object.values(AB).flat().forEach(a=>{a.tip=playerFacingAbilityTooltip(a);});
 Object.values(TALENT_UNLOCKED_ABILITIES).flatMap(defs=>Object.values(defs||{})).forEach(a=>{a.tip=playerFacingAbilityTooltip(a);});
}
refreshAbilityTooltips();

const SUPPORTED_TALENT_ABILITY_TYPES=new Set(['damage','heal','hot','bigHeal','shield','shieldSelf','defensive','warriorGuard','sharpenBlade','intercept','avatar','passiveOnly','monkDefensive','ironbark','natureSwiftness','undyingResolve','buff','blind','gouge','fear','cleanse','freedom','guardianAngel','root','slow','singleStun','groundStun','summonInfernal','windStun','leap','push','dot','livingBomb','combustion','flameShield','evasion','cloak','crimsonVial','internalBleeding','vendetta','totemMastery','healingStreamTotem','stormkeeper','frostShock','karma','tigereyeBrew','soulDrain','chaosBolt','holyShock','windlordStrike','chiBurst','touchOfDeath','stormbolt','fistsChannel','whirlingDragonPunch','meteor','bladestorm','warbreaker','victoryRush','shiv','tigersLust','bestowFaith','ghanir','flameShock','volcanicEruption','avengingWings','archangel','darkArchangel','angelicBody','alterTime']);
function validateTalentAbilityDefinitions(){
 const missing=[];
 Object.entries(TALENT_UNLOCKED_ABILITIES||{}).forEach(([cls,defs])=>{
  Object.entries(defs||{}).forEach(([id,a])=>{if(!SUPPORTED_TALENT_ABILITY_TYPES.has(a.type))missing.push(`${cls}.${id}:${a.type}`);});
 });
 if(missing.length)console.warn('Unsupported talent ability types:',missing.join(', '));
 return missing;
}
validateTalentAbilityDefinitions();


function sanitizeWindwalkerAbilities(){
 if(typeof AB==='undefined'||!AB.wind)return;
 const fallback={'Zephyr Palm':72,'Cloudstep Kick':98,'Fists of Fury':68,'Cyclone Barrage':82,'Disrupting Palm':48,'Valley Sweep':42,'Strike of the Windlord':160,'Chi Burst':120,'Disabling Reach':36};
 AB.wind.forEach(a=>{
  if(['damage','leap','monkFinisher','fistsChannel','windInterrupt','windStun','windlordStrike','chiBurst','frostShock'].includes(a.type)&&(!Number.isFinite(Number(a.value))||Number(a.value)<=0)){
   a.value=fallback[a.name]||80;
  }
 });
}

function syncTalentUnlockedAbilities(){
 if(typeof AB==='undefined'||typeof progression==='undefined')return;sanitizeWindwalkerAbilities();
 if(!window.__AB_BASE)window.__AB_BASE=Object.fromEntries(Object.entries(AB).map(([k,v])=>[k,v.map(a=>({...a}))]));
 if(typeof TALENT_TREES!=='undefined')Object.keys(TALENT_TREES).forEach(cls=>{
  const saved=progression.talents?.[cls];if(!saved)return;
  pruneTalentCapstoneOverflow(TALENT_TREES[cls],saved);
  /* Drop ranks saved against nodes that no longer exist, so removed talents do not
     keep eating points out of the budget. */
  const ids=new Set((TALENT_TREES[cls]||[]).map(n=>n.id));
  Object.keys(saved).forEach(id=>{if(!ids.has(id))delete saved[id];});
 });
 Object.keys(window.__AB_BASE).forEach(cls=>{
  const learned=progression.talents?.[cls]||{};
  AB[cls]=window.__AB_BASE[cls].map(a=>({...a}));
  const defs=TALENT_UNLOCKED_ABILITIES[cls]||{};
  Object.entries(defs).forEach(([talentId,ability])=>{
   if((learned[talentId]||0)<=0||ability.type==='passiveOnly')return;
   const tuned={...ability,talentAbility:true};
   if(tuned.cost&&!['sage','pala','disc'].includes(cls))tuned.cost=Math.max(1,Math.ceil(tuned.cost*.30));
   if(cls==='soul'&&talentId==='soul_void_mend'){
    const replaced=AB[cls].findIndex(a=>a.name==='Unstable Affliction');
    if(replaced>=0)AB[cls].splice(replaced,1,tuned);
    else if(!AB[cls].some(a=>a.name===tuned.name))AB[cls].push(tuned);
    const torment=AB[cls].findIndex(a=>a.name==='Creeping Torment');
    const immolate={...CHAOS_IMMOLATE_ABILITY,tip:playerFacingAbilityTooltip(CHAOS_IMMOLATE_ABILITY)};
    if(torment>=0)AB[cls].splice(torment,1,immolate);
    const siphon=AB[cls].find(a=>a.name==='Essence Siphon');
    if(siphon)siphon.tip='Channel for 2.5 sec, or 1.5 sec against a target affected by your Immolate, damaging the enemy and healing yourself every 0.5 sec. Soul Scar and Immolate strengthen every tick. Each tick reduces Chaos Bolt cooldown by 3 sec. Press Essence Siphon again to stop the channel early. Target: a living enemy.';
    return;
   }
   if(!AB[cls].some(a=>a.name===tuned.name))AB[cls].push(tuned);
  });
 });
 if(window.game&&game.player){const needed=AB[game.player.cls].length;while(game.player.cds.length<needed)game.player.cds.push(0);}
}

const EFFECT_META={volcanicEruptionReady:{label:'Volcanic Eruption Ready',icon:'🌋',buff:true},pandemicSurge:{label:'Pandemic Bloom +20%',icon:'🌑',buff:true},staticAegisGuard:{label:'Static Aegis Guard',icon:'🛡️',buff:true},furyStun:{label:'Pummeled',icon:'🥊',cc:true},stun:{label:'Stunned',icon:'⛔',cc:true},fear:{label:'Feared',icon:'😱',cc:true},poly:{label:'Polymorph',icon:'🐑',cc:true},sleep:{label:'Slumber',icon:'🌸',cc:true},blind:{label:'Blinded',icon:'👁️',cc:true},gouge:{label:'Gouged',icon:'👁️',cc:true},windIncap:{label:'Incapacitated',icon:'💫',cc:true},root:{label:'Rooted',icon:'🕸️',cc:true},slow:{label:'Snared',icon:'🐌',cc:true},frostShockAmp:{label:'Frost Shock · Arc/Fork +15%',icon:'❄️'},instantBolt:{label:'Hot Streak',icon:'✨',buff:true},interruptPower:{label:'Counterflare',icon:'🔶',buff:true},stormChance:{label:'Surge Chance',icon:'🎲',buff:true},tempestBolts:{label:'Tempest Bolts',icon:'⚡',buff:true},overload:{label:'Volcanic Overload',icon:'🌋',buff:true},cloudstepDashCd:{label:'Dash Recharge',icon:'💨',buff:true},shadowMarks:{label:'Shadow Marks',icon:'🗡️',buff:true},venomEdge:{label:'Venom Edge',icon:'🦂',buff:true},smokePower:{label:'Veiled Assault',icon:'🌫️',buff:true},evasion:{label:'Evasion',icon:'💨',buff:true},eviscerateReady:{label:'Eviscerate Ready',icon:'⚔️',buff:true},cheapReady:{label:'Cheap Shot Ready',icon:'🔪',buff:true},smokeBombReady:{label:'Smoke Bomb Ready',icon:'💣',buff:true},smokeBomb:{label:'Smoke Bomb',icon:'⚫',cc:true},cheapStun:{label:'Cheap Shot',icon:'🔪',cc:true},flow:{label:'Flow',icon:'👊',buff:true},tempestFlow:{label:'Tempest Flow',icon:'🌪️',buff:true},furyReady:{label:'Fury Ready',icon:'🥊',buff:true},furySequence:{label:'Fury Chain',icon:'☯️',buff:true},cinderStacks:{label:'Cinders',icon:'🔥',buff:true},meteorICD:{label:'Meteor CD',icon:'☄️',buff:true},meteorLance:{label:'Meteor Lance Ready',icon:'☄️',buff:true},soulScar:{label:'Soul Scar',icon:'🕯️'},agony:{label:'Torment',icon:'🪬'},unstableAffliction:{label:'Unstable Affliction',icon:'🟣'},interruptWard:{label:'Soul Barrier Ward',icon:'🔮',buff:true},burn:{label:'Burn',icon:'🔥'},poison:{label:'Poison',icon:'☠️'},hot:{label:'HoT',icon:'🍃'},shield:{label:'Shield',icon:'🛡️',buff:true},iceBlock:{label:'Ice Block',icon:'🧊',buff:true},infusion:{label:'Infusion of Light',icon:'✨',buff:true},sacrifice:{label:'Blessing of Sacrifice',icon:'🪽',buff:true},avengingWings:{label:'Avenging Wings',icon:'🪽',buff:true},divineSteed:{label:'Divine Steed',icon:'🐴',buff:true},burst:{label:'Burst',icon:'🌋',buff:true},defensive:{label:'Guard',icon:'🛡️',buff:true},natureSwiftness:{label:'Nature Swiftness',icon:'🌿',buff:true},ironbark:{label:'Ironbark',icon:'🌳',buff:true},shadowMendGuard:{label:'Shadow Mend Guard',icon:'🌓',buff:true},tigereyeBrew:{label:'Tigereye Brew',icon:'🍺',buff:true},undyingResolve:{label:'Undying Resolve',icon:'🟣',buff:true},bleed:{label:'Rend',icon:'🩸'},reflect:{label:'Spell Reflect',icon:'🛡️',buff:true},empoweredSwing:{label:'Empowered Slam',icon:'⚔️',buff:true},victoryRushBoost:{label:'Victory Rush Primed',icon:'🏆',buff:true},gushingWoundReady:{label:'Gushing Wound',icon:'🩸',buff:true},combustion:{label:'Combustion',icon:'🔥',buff:true},moltenArmor:{label:'Fire Shield',icon:'🛡️',buff:true},livingBomb:{label:'Living Bomb',icon:'💣'},cauterizeDoom:{label:'Cauterize',icon:'❤️‍🔥',buff:true},cloakShadows:{label:'Cloak of Shadows',icon:'🧥',buff:true},vendetta:{label:'Vendetta',icon:'🎯'},stealth:{label:'Stealth',icon:'👻',buff:true},tigereye:{label:'Tigereye Brew',icon:'🍺',buff:true},touchKarma:{label:'Touch of Karma',icon:'☯️',buff:true},tigersLust:{label:"Tiger's Lust",icon:'🐯',buff:true},risingSunReady:{label:'Rising Sun Kick',icon:'🌅',buff:true},ghanir:{label:"G'Hanir",icon:'🌲',buff:true},bestowFaith:{label:'Bestow Faith',icon:'🙏',buff:true},atonement:{label:'Atonement',icon:'✦',buff:true},painSuppression:{label:'Pain Suppression',icon:'🕊️',buff:true},discFade:{label:'Fade',icon:'🤍',buff:true},archangel:{label:'Archangel',icon:'🪽',buff:true},darkArchangel:{label:'Dark Archangel',icon:'🖤',buff:true},angelicBody:{label:'Angelic Body',icon:'💨',buff:true},radiantPenanceProc:{label:'Radiant Penance',icon:'🌠',buff:true},flameShock:{label:'Flame Shock',icon:'🔥'},shivPoisonAmp:{label:'Shiv Poison Vulnerability',icon:'☠️'},silence:{label:'Silenced',icon:'🤫',cc:true},karmaDot:{label:'Karma',icon:'☯️'},totemMastery:{label:'Totem Mastery',icon:'🪧',buff:true},stormkeeper:{label:'Stormkeeper',icon:'⛈️',buff:true},rushingJade:{label:'Rushing Jade Wind',icon:'🌀',buff:true}};
EFFECT_META.touchOfDeath={label:'Touch of Death',icon:'☠️'};
EFFECT_META.infernalExposure={label:'Infernal Vulnerability · +10%',icon:'🔥'};
EFFECT_META.infernalLifetime={label:'Infernal Remaining',icon:'🔥',buff:true};
EFFECT_META.freedom={label:'Blessing of Freedom · +30% Speed',icon:'🪽',buff:true};
EFFECT_META.guardianImmunity={label:'Guardian Angel · Immune',icon:'👼',buff:true};
EFFECT_META.guardianLifetime={label:'Val’kyr Remaining',icon:'👼',buff:true};
EFFECT_META.shadowmoonFragments={label:'Soul Fragments',icon:'💜',buff:true};
EFFECT_META.chaosBaneStrength={label:'Chaos Bane Strength',icon:'🌘',buff:true};
EFFECT_META.lightningRod={label:'Lightning Rod',icon:'⚡'};
EFFECT_META.sharpenBladeReady={label:'Sharpen Blade Ready',icon:'🗡️',buff:true};
EFFECT_META.sharpenedWound={label:'Sharpened Wound · Healing -40%',icon:'🩸'};
EFFECT_META.sharpenRenewal={label:'Sharpen Renewal · 3%/sec',icon:'❤️',buff:true};
EFFECT_META.interceptGuard={label:'Intercepted',icon:'🛡️',buff:true};
EFFECT_META.slicingWinds={label:'Slicing Winds',icon:'⚔️',buff:true};
EFFECT_META.renewalVerdant={label:'Verdant Mend +150%',icon:'🌿',buff:true};
EFFECT_META.crimsonVial={label:'Crimson Vial',icon:'🧪',buff:true};
EFFECT_META.holdTheLine={label:'Hold the Line',icon:'🧱',buff:true};
EFFECT_META.temperedFocus={label:'Tempered Focus',icon:'🎯',buff:true};
EFFECT_META.aftershockPower={label:'Aftershock',icon:'📡',buff:true};
EFFECT_META.curseWeavingPower={label:'Curse Weaving',icon:'🪬',buff:true};
EFFECT_META.immolate={label:'Immolate',icon:'🔥'};
EFFECT_META.overheatPower={label:'Overheat',icon:'♨️',buff:true};
function effectMeta(type){if(type.startsWith('lock_'))return {label:'Locked',icon:'🔒',cc:true}; return EFFECT_META[type]||{label:type,icon:'•'};}
function isUntargetableStealth(u,viewer){return !!(u&&u.alive&&u.has&&u.has('stealth')&&viewer&&viewer.team!==u.team);} function crowdControlState(u){const order=['furyStun','cheapStun','fear','poly','sleep','gouge','blind','windIncap','stun','silence','root','lock_fire','lock_arcane','lock_nature','lock_storm','lock_physical','silence','slow'];for(const type of order){const e=u.effects.find(x=>x.type===type&&x.time>0); if(e)return {...effectMeta(type),type,time:e.time};}return null;} function centerControlState(u){const order=['furyStun','cheapStun','stun','fear','poly','sleep','gouge','blind','windIncap','root'];for(const type of order){const e=u.effects.find(x=>x.type===type&&x.time>0);if(e)return {...effectMeta(type),type,time:e.time};}return null;}
const CLASS_MECHANICS={
 flame:'Counterflare and Frostfire Nova can be used between your other abilities. A successful Counterflare empowers two instant Cinder Bolts. Meteor is aimed on the ground and, after landing, empowers one rapid Ember Lance. Ice Block is your emergency immunity and recovery spell.',
 storm:'Keep Flame Shock active, use Skybreaker Pulse to ready one Volcanic Eruption, and cast Arc Spark to build your chance of triggering Storm Surge. Healing Surge provides recovery, while Static Aegis combines an absorption shield with 20% damage reduction.',
 shadow:'Umbral Pounce grants a brief 50% chance to dodge melee attacks. Ribbreaker empowers your next Night Slash. Shadow Kick can interrupt an enemy cast immediately without delaying your other abilities.',
 sage:"G'Hanir strengthens and speeds up Blooming Echo and Rejuvenate for 7 sec. Renewal Tide is your emergency team heal and empowers your next Verdant Mend by 150%. Nature Swiftness can be spent on Renewal Tide or Lullaby Bloom, while Ironbark reduces damage and improves healing received.",
 pala:'Bestow Faith provides delayed recovery, Divine Toll fires three Holy Shocks, and Word of Glory provides an instant emergency heal. Infusion of Light makes your next Holy Light faster and refunds mana.',
 disc:'Atonement healer mechanic: Power Shield, Shadow Mend and Ultimate Radiance apply Atonement. Smite, Penance and Solace deal deliberately low damage but convert into substantially stronger healing for every Atonement ally.',
 wind:'Zephyr Palm builds Flow. Strike of the Windlord prepares a glowing Rising Sun Kick. Fists of Fury is a cancellable moving channel that slows by 60%; once Fists of Fury is on cooldown, Whirling Dragon Punch becomes available. Touch of Death records five seconds of damage and then detonates part of it.',
 soul:'Maintain Soul Scar, Creeping Torment and up to three Unstable Afflictions to strengthen Essence Siphon. Shadowfury controls an area and empowers the next Pandemic Bloom.',
 warrior:'Warrior mechanic: a melee bruiser fuelled by energy. Charge closes from range, roots for 1.5 sec and leaves a 45% snare for 4 sec; Rend layers a bleed; Pummel locks the interrupted school for 3 sec and readies one Mortal Swing with 30% more damage. Stormbolt creates ranged stun setups, while Warbreaker and Avatar stack into the empowered strike.'
};
const CLASS_PASSIVES={
 flame:'Meteor lets you choose a ground location for a delayed impact. When it lands, your next Ember Lance is empowered and can be fired immediately between other abilities. Counterflare empowers instant Cinder Bolts. Ice Block restores health while protecting you.',
 shadow:'Three Night Slashes empower Viper Cut into Venom Edge. Umbral Pounce grants a 50% chance to dodge melee attacks for 1.5 sec. Ribbreaker empowers the next Night Slash. Veiled Assault prepares Cheap Shot and Smoke Bomb. Shadow Kick interrupts nearby casts.',
 storm:'Storm Surge: Arc Spark begins with a 10% chance to trigger it, gaining another 10% after each failed roll. Triggering Storm Surge restores 10 mana and prepares two Tempest Bolts plus an empowered Forked Current. Tempest Bolt hits restore 5 mana each; the empowered Forked Current restores 10 mana and launches three smaller Lava Bursts.',
 wind:'Flow rewards sustained martial pressure. Touch of Death can be used immediately between other abilities and detonates 30% of the damage loaded into its five-second mark. Strike of the Windlord prepares Rising Sun Kick. Whirling Dragon Punch glows and becomes usable while Fists of Fury is on cooldown.',
 sage:'Renewal Tide is a large emergency heal and empowers the next Verdant Mend by 150%. Left-click an enemy in range whenever you want to fire one Verdant Bolt; targeting alone never starts a repeating attack.',
 pala:'Holy Shock can heal or damage and can grant Infusion of Light. Left-click an enemy in melee range whenever you want to perform one Righteous Strike; targeting alone never starts a repeating attack.',
 disc:'Atonement: Power Shield, Shadow Mend and Ultimate Radiance mark allies. Smite, Penance and Solace deal low damage but convert into much stronger healing for every marked ally. Pain Suppression and Radiance answer lethal spikes.',
 soul:'Soulweaver can use one normal ability every 0.5 sec and has strong mana recovery. Soul Scar, Creeping Torment and up to three Unstable Afflictions strengthen every tick of Essence Siphon, which also restores your health.',
 warrior:'Empowered Swing: interrupting a cast with Pummel readies one Mortal Swing at +30% damage, multiplicatively stacking with Warbreaker and Avatar. Bloodletting: Rend can expose Gushing Wound, an instant follow-up that accelerates the bleed.'
};
const CLASS_GAME_PLANS={
 flame:{core:'Keep distance, root melee attackers, and use Prism Hex to create a safe cast window.',burst:'Press Meteor when your target is exposed, then fire the readied Meteor Lance during your Cinder Bolt pressure.',survival:'Blazing Step creates space. Fire Shield softens pressure. Ice Block is your emergency immunity.'},
 shadow:{core:'Stay connected with Umbral Pounce and Night Slash. Build three Shadow Marks, then spend the Venom Edge proc with Viper Cut.',burst:'Use Ribbreaker or Cheap Shot to hold the target still, then combine Vendetta, Garrote and Eviscerate pressure.',survival:'Smoke Veil breaks enemy targeting and hides you. Evasion handles melee; Cloak handles magic and damage-over-time effects.'},
 storm:{core:'Keep Flame Shock active and cast Arc Spark to build Storm Surge procs. Lightning Rod is created only by a Stormkeeper-empowered Arc Spark.',burst:'Use Stormkeeper to establish Lightning Rod, then Skybreaker Pulse and Forked Current into marked targets for 20% increased damage.',survival:'Static Aegis reduces damage. Healing Stream Totem provides killable area recovery, while the faster Healing Surge handles emergencies.'},
 wind:{core:'Use Zephyr Palm to build Flow and Tigereye Brew stacks while Cloudstep keeps you in melee range.',burst:'At four to six Tigereye stacks, combine Strike of the Windlord, Rising Sun Kick, Touch of Death, Fists of Fury and Whirling Dragon Punch.',survival:'Tiger’s Lust removes movement effects. Willow Guard and Touch of Karma let you keep attacking under pressure.'},
 soul:{core:'Maintain Soul Scar, Creeping Torment and up to three Unstable Afflictions. Three UA stacks are your strongest sustained pressure.',burst:'Use Shadowfury to empower Pandemic Bloom, then channel Essence Siphon once the full set of afflictions is active.',survival:'Soul Barrier protects casts. Mortal Horror creates space and heals you. Undying Resolve and Dark Pact answer heavy burst.'},
 sage:{core:'Keep Blooming Echo and Rejuvenate active together; each lasts 12 seconds and heals independently.',burst:'G’Hanir speeds and strengthens your active HoTs. Nature Swiftness can create an instant emergency heal or instant Lullaby Bloom.',survival:'Use Ironbark before large incoming damage, Renewal Tide for emergencies, and Fae Retreat to restore safe positioning.'},
 pala:{core:'Holy Shock is your flexible instant heal. Use Holy Light when safe, and Bestow Faith before damage arrives.',burst:'Avenging Wings increases healing and damage. Divine Toll gives three Holy Shock events for rapid recovery.',survival:'Blessing of Sacrifice protects an ally, Divine Protection protects you, and Hammer of Justice peels attackers.'},
 disc:{core:'Apply Atonement with Power Shield or Shadow Mend, then deal holy damage to heal every marked ally.',burst:'Ultimate Radiance stabilises the team and readies faster Radiant Penance. Dark Archangel trades safety for damage pressure.',survival:'Pain Suppression is your largest save. Fade and Angelic Body help you reposition while continuing to heal.'},
 warrior:{core:'Charge into melee, maintain Rend, and use Mortal Swing as your reliable pressure strike.',burst:'Stack Avatar and Warbreaker, then land the empowered Mortal Swing. Pummel adds another 30% when it interrupts a cast.',survival:'Spell Reflect answers predictable magic. Shield Wall reduces incoming damage, and Victory Rush restores health while attacking.'}
};

const GEAR_CLASSES=['flame','shadow','storm','wind','soul','sage','pala','disc','warrior'];
const GEAR_SLOTS=['Head','Neck','Shoulders','Back','Chest','Wrist','Gloves','Waist','Legs','Feet','Ring','Trinket','Weapon'];
const LEFT_GEAR_SLOTS=['Head','Neck','Shoulders','Back','Chest','Wrist'];
const RIGHT_GEAR_SLOTS=['Gloves','Waist','Legs','Feet','Ring','Trinket','Weapon'];
const SLOT_ICONS={Head:'⛑️',Neck:'📿',Shoulders:'🛡️',Back:'🧥',Chest:'🥋',Wrist:'⌚',Gloves:'🧤',Waist:'➰',Legs:'👖',Feet:'🥾',Ring:'💍',Trinket:'🔮',Weapon:'⚔️'};
const GEAR_STATS=['Stamina','Intellect','Agility','Strength','Power','Restoration','Vitality','Mana','Versatility','Critical Strike'];
const CUSTOM_GEAR_STATS=['Power','Restoration','Vitality','Mana','Versatility','Critical Strike'];
const CLASS_PRIMARY={flame:'Intellect',storm:'Intellect',soul:'Intellect',sage:'Intellect',pala:'Intellect',disc:'Intellect',shadow:'Agility',wind:'Agility',warrior:'Strength'};
const GEAR_BUILD_INFO={
 flame:{name:'Meteor Burst',stats:['Power','Mana'],text:'Power strengthens Meteor Lance and Cinder pressure; Mana supports longer setup games.'},
 shadow:{name:'Smoke Execution',stats:['Power','Versatility'],text:'Power rewards kill windows, while Versatility lets Shadowblade stay connected.'},
 storm:{name:'Storm Surge Sustain',stats:['Mana','Power'],text:'Mana enables longer casting cycles; Power lifts proc burst.'},
 wind:{name:'Pressure Walker',stats:['Power','Vitality'],text:'Power improves combo finishing and Vitality helps you stay aggressive in melee.'},
 soul:{name:'Rot & Drain',stats:['Mana','Power'],text:'Mana maintains multiple DoTs; Power increases drain and affliction pressure.'},
 sage:{name:'Verdant Endurance',stats:['Restoration','Mana'],text:'Restoration strengthens saves and Mana supports extended healing rounds.'},
 pala:{name:'Sacrificial Protector',stats:['Restoration','Vitality'],text:'Restoration boosts Wings recovery; Vitality makes Sacrifice safer.'},
 disc:{name:'Atonement Conversion',stats:['Restoration','Mana'],text:'Restoration strengthens Atonement conversion, shields and emergency heals; Mana sustains repeated offensive healing cycles.'},
 warrior:{name:'Shadowmoon Bruiser',stats:['Power','Critical Strike'],text:'Power drives Mortal Swing and Rend pressure; Critical Strike creates heavier kill windows.'}
};
const GEAR_THEMES={flame:'Cinderweave',shadow:'Nightveil',storm:'Tempestbound',wind:'Skyfist',soul:'Dreadthread',sage:'Wildbloom',pala:'Dawnward',disc:'Absolution',warrior:'Ironhide'};
const SLOT_NAMES={Weapon:'Implement',Head:'Crown',Neck:'Pendant',Shoulders:'Mantle',Back:'Cloak',Chest:'Vestment',Wrist:'Bindings',Gloves:'Grips',Waist:'Girdle',Legs:'Legguards',Feet:'Treads',Ring:'Signet',Trinket:'Emblem'};
const RARITY_INFO={uncommon:{name:'Uncommon',colour:'#40c961'},rare:{name:'Rare',colour:'#408df5'},elite:{name:'Elite',colour:'#ef5459'},mythical:{name:'Mythical',colour:'#c47bff'},legendary:{name:'Legendary',colour:'#ff9d3d'}};
const SHADOWMOON_COST=12000;
const GEAR_RECRAFT_RATE=.43;
const SHADOWMOON_RATING=2700;
const SHADOWMOON_PROC_CHANCE=.40;
const SHADOWMOON_FRAGMENT_STRENGTH=8;
const SHADOWMOON_CHAOS_STRENGTH=120;
const SHADOWMOON_CHAOS_DAMAGE=500;
const SHADOWMOON_STRENGTH_DAMAGE_PER_POINT=.00075;
const LEGENDARY_WEAPONS={flame:'Pyreheart Phoenix Staff',shadow:'Voidfang Twinblades',storm:'Stormspire Worldcoil',wind:'Jade Serpent Cloud Glaive',soul:'Abyss-Eye Soulreaper',sage:'Worldbloom Heartstaff',pala:'Dawnwing Oathbreaker',disc:'Absolution Star-Staff',warrior:'Worldsplitter Warblade'};
const ELITE_WEAPON_TYPES={flame:'Inferno Focus',shadow:'Riftknife Set',storm:'Voltbrand Rod',wind:'Tempest Glaive',soul:'Hexbound Grimoire',sage:'Bloomcaller Staff',pala:'Sunsteel Hammer',disc:'Penitent Censer',warrior:'Colosseum Greatblade'};
function rarityForIlvl(ilvl){return ilvl>=1000?'legendary':ilvl>=950?'mythical':ilvl>=935?'elite':ilvl>=920?'rare':'uncommon';}
function rarityLabel(ilvl){return RARITY_INFO[rarityForIlvl(ilvl)].name;}
function allCatalogueItems(){const items=[];GEAR_CLASSES.forEach(cls=>GEAR_SLOTS.forEach(slot=>{for(let ilvl=910;ilvl<=990;ilvl+=(ilvl<950?5:10)){const build=GEAR_BUILD_INFO[cls].stats;items.push(createGearItem(cls,slot,ilvl,build[0],build[1],'Collection Catalogue'));}}));return items;}
const MOUNT_CATALOGUE=[
 {id:'skyhoof',name:'Skyhoof Courser',icon:'🐎',rarity:'common',rarityLabel:'Common',base:true,model:'courser',desc:'A reliable astral starter mount with a clean silhouette and an easy, readable ride.',lore:'Light armour, bright reins and a steady canter make Skyhoof the dependable first pick in every stable.',source:'Available from the start',body:0x826956,accent:0xe1c69a,aura:0xbbeaff,scale:1.36,riderY:.73},
 {id:'duskfang',name:'Duskfang Sabre',icon:'🐅',rarity:'rare',rarityLabel:'Rare',base:true,model:'sabre',desc:'A quick-footed sabrecat with blue arcane trim and a predatory profile.',lore:'Bred for speed and tight turns, Duskfang trades heavy armour for a feline silhouette and quiet arcane shimmer.',source:'Available from the start',body:0x2b3143,accent:0x65b5ff,aura:0x55aaff,scale:1.35,riderY:.75},
 {id:'groveram',name:'Grovehorn Ram',icon:'🐏',rarity:'rare',rarityLabel:'Rare',base:true,model:'ram',desc:'A broad ram with polished horns and emerald barding, made for collectors who prefer weight and character.',lore:'Grovehorn was bred for rocky climbs and arena entrances; its curled horns are instantly recognisable.',source:'Available from the start',body:0x4d5546,accent:0x57bbdb,aura:0x55aaff,scale:1.42,riderY:.78},
 {id:'stormdrake',name:'Stormwake Drake',icon:'🐉',rarity:'epic',rarityLabel:'Epic',base:true,model:'drake',desc:'A rare storm-touched drake whose fins and tail crackle with blue-violet light.',lore:'Collectors value Stormwake for its magical silhouette: not a rating reward, but clearly more exotic than common steeds.',source:'Collector starter reward',body:0x263859,accent:0xbc74ff,aura:0xa95cff,scale:1.4,riderY:.79},
 {id:'infernalwarstrider',name:'Infernal Warstrider',icon:'🔥',rarity:'legendary',rarityLabel:'Legendary',base:false,model:'charger',threshold:2000,desc:'A prestige warhorse with molten armour lines and burning hooves, awarded at 2000 rating.',lore:'Forged for players who push into the elite bracket, Infernal Warstrider carries a brighter aura and fiery hoof trails.',source:'Reach 2000 rating',body:0x361512,accent:0xff8b34,aura:0xff631f,scale:1.49,riderY:.97},
 {id:'aetherdeathcharger',name:'Aether Deathcharger',icon:'💀',rarity:'gladiator',rarityLabel:'Aether Legend',base:false,model:'deathcharger',threshold:2200,desc:'A dark armoured deathcharger awarded at 2200 rating for players who reach Aether Legend.',lore:'A prestige stable reward: plated, spiked and wreathed in ghostfire for competitors who break into legend territory.',source:'Reach 2200 rating',body:0x121820,accent:0x5fe7ff,aura:0x5fe7ff,scale:1.56,riderY:1.23},
 {id:'aethergladiatorwyrm',name:'Aether Gladiator Wyrm',icon:'🐲',rarity:'gladiator',rarityLabel:'Aether Gladiator',base:false,model:'aetherwyrm',threshold:2400,desc:'A huge purple armoured arena wyrm inspired by old-school gladiator drakes, awarded at 2400 rating.',lore:'A true 2400 prize: angular dragon body, plated jaw armour, silver shoulder plates, glowing violet wings and a silhouette unlike any baseline mount in the stable.',source:'Reach 2400 rating',body:0x31155c,accent:0xcaf4ff,aura:0xb575ff,scale:1.45,riderY:1.08,skins:{default:{label:'Violet Gladiator',body:0x2a0f55,accent:0xe4d1ff,aura:0xbc6dff},silverstorm:{label:'Silverstorm 2700 2v2',body:0xf2f7ff,accent:0x2eeaff,aura:0x9af6ff},emeraldrift:{label:'Emerald Rift 2700 3v3',body:0x052b1d,accent:0xc7ffd8,aura:0x00ff84},crimsonvoid:{label:'Crimson Void 3000 2v2',body:0x12020a,accent:0xffcad8,aura:0xff003f,skinFx:'void'},goldenascendant:{label:'Golden Ascendant 3000 3v3',body:0x5b3903,accent:0xffffbf,aura:0xffd000,skinFx:'ascendant'},duelistbronze:{label:'Bronze Duelist 1800 1v1',body:0x3d2409,accent:0xffd9a0,aura:0xff9d2e},soloascendant:{label:'Solo Ascendant 2100 1v1',body:0x07283a,accent:0xd6f6ff,aura:0x33d9ff},lonewolf:{label:'Lone Wolf 2400 1v1',body:0x1a1a1f,accent:0xf0f0f5,aura:0xb8b8c8},duelistvoid:{label:'Duelist Void 2700 1v1',body:0x0d0416,accent:0xe0c2ff,aura:0x8a2be2,skinFx:'void'},monarchsolus:{label:'Monarch Solus 3000 1v1',body:0x4a0d0d,accent:0xfff0c2,aura:0xff2d2d,skinFx:'ascendant'}}},
 {id:'chronocrown_protodrake',name:'Chronocrown Proto-Drake',icon:'🐲',rarity:'gladiator',rarityLabel:'Aether Cup',base:false,model:'protodrake',threshold:0,defaultSkin:'storm',desc:'A unique Aether Cup proto-drake mount with class colour schemes unlocked by winning the tournament on each class.',lore:'A low, plated proto-drake inspired by elite arena trophy mounts: thick armoured shoulders, crystal spines, glowing cracked hide, heavy claws, wing membranes and a raised crown crest. Each class unlocks its own colour scheme rather than creating a separate mount entry.',source:'Win the Aether Cup on any class',body:0xf2f7ff,accent:0x2eeaff,aura:0x9af6ff,scale:1.50,riderY:1.12,skins:{flame:{label:'Flame Duelist',unlock:'Win Aether Cup as Flame Duelist',body:0x7a1d14,accent:0xffc46b,aura:0xff6f24,hideEmissive:0x421008},shadow:{label:'Shadowblade',unlock:'Win Aether Cup as Shadowblade',body:0x181020,accent:0xb98cff,aura:0x8b4dff,hideEmissive:0x150520},storm:{label:'Stormwarden',unlock:'Win Aether Cup as Stormwarden',body:0xf2f7ff,accent:0x2eeaff,aura:0x9af6ff,hideEmissive:0x122f55},wind:{label:'Windwalker',unlock:'Win Aether Cup as Windwalker',body:0x153c2b,accent:0xc8ffe0,aura:0x72ffb1,hideEmissive:0x052415},soul:{label:'Soulbinder',unlock:'Win Aether Cup as Soulbinder',body:0x101729,accent:0xa98cff,aura:0x5f7dff,hideEmissive:0x070a22},sage:{label:'Lifesage',unlock:'Win Aether Cup as Lifesage',body:0x1b4d35,accent:0xeaffc8,aura:0x74ff8e,hideEmissive:0x082815},pala:{label:'Paladin',unlock:'Win Aether Cup as Paladin',body:0xd8d3bd,accent:0xffdf8a,aura:0x7fdfff,hideEmissive:0x2d2612},disc:{label:'Discipline',unlock:'Win Aether Cup as Discipline',body:0xf2f2f7,accent:0xffe69a,aura:0xd8c8ff,hideEmissive:0x24212f},warrior:{label:'Warrior',unlock:'Win Aether Cup as Warrior',body:0x4a4b50,accent:0xffb072,aura:0xff4545,hideEmissive:0x1c1111}}},
  {id:'hellfiregladiatorwyrm3200',name:'Hellfire Gladiator Wyrm',icon:'🔥',rarity:'gladiator',rarityLabel:'3200 Rating',base:false,model:'aetherwyrm',threshold:3200,desc:'The enhanced hellfire version of the former tournament wyrm: heavier armour, deeper crimson scales and arena fire around the wings and crest.',lore:'A 3200-rating prestige colour for the Aether Gladiator Wyrm line, built for players who want the red hellfire look as the true elite chase reward.',source:'Reach 3200 rating',body:0x74221d,accent:0xc9a56b,aura:0xff6f24,scale:1.48,riderY:1.1,armourPrimary:0xb89a67,armourDark:0x54423a,wingGlow:0xff6f24,hideEmissive:0x3a0d08,eyeGlow:0xff8e2f,skinFx:'ascendant'}
];
function mountDefinition(id){const base=MOUNT_CATALOGUE.find(m=>m.id===id)||MOUNT_CATALOGUE[0];if(base?.skins){const fallback=base.defaultSkin||'default',skinId=(typeof progression!=='undefined'&&progression.activeMountSkins?.[base.id])||fallback,skin=base.skins[skinId]||base.skins[fallback]||Object.values(base.skins)[0];if(skin)return {...base,...skin,skinId,skinLabel:skin.label};}return base;}function mountSkinPreviewDefinition(id,skinId){const base=MOUNT_CATALOGUE.find(m=>m.id===id)||MOUNT_CATALOGUE[0];if(base?.skins){const fallback=base.defaultSkin||'default',skin=base.skins[skinId]||base.skins[fallback]||Object.values(base.skins)[0];if(skin)return {...base,...skin,skinId:skinId||fallback,skinLabel:skin.label};}return base;}
function baselineMountIds(){return MOUNT_CATALOGUE.filter(m=>m.base).map(m=>m.id);}function chronocrownMountIdForClass(cls){return 'chronocrown_protodrake';}
function chronocrownSkinIdForClass(cls){return {flame:'flame',shadow:'shadow',storm:'storm',wind:'wind',soul:'soul',sage:'sage',pala:'pala',disc:'disc',warrior:'warrior'}[cls]||'storm';}
function chronocrownClassLabel(cls){return CLASS_INFO?.[cls]?.name||cls||'Champion';}

function unlockEligibleMounts(p){p.mounts=Array.isArray(p.mounts)?p.mounts.filter(id=>MOUNT_CATALOGUE.some(m=>m.id)):[];p.mountSkins=p.mountSkins||{};p.activeMountSkins=p.activeMountSkins||{};
 const oldMap={chronocrown_flame:'flame',chronocrown_shadow:'shadow',chronocrown_storm:'storm',chronocrown_wind:'wind',chronocrown_soul:'soul',chronocrown_sage:'sage',chronocrown_pala:'pala',chronocrown_warrior:'warrior',chronocrowngryphon:'flame'};
 Object.entries(oldMap).forEach(([oldId,skin])=>{if(p.mounts.includes(oldId)){p.mounts=p.mounts.filter(x=>x!==oldId);if(!p.mounts.includes('chronocrown_protodrake'))p.mounts.push('chronocrown_protodrake');p.mountSkins.chronocrown_protodrake=Array.from(new Set([...(p.mountSkins.chronocrown_protodrake||[]),skin]));if(p.activeMount===oldId){p.activeMount='chronocrown_protodrake';p.activeMountSkins.chronocrown_protodrake=skin;}}});
 p.mounts=p.mounts.filter(id=>MOUNT_CATALOGUE.some(m=>m.id===id));
 baselineMountIds().forEach(id=>{if(!p.mounts.includes(id))p.mounts.push(id);});
 const highest=Math.max(1600,...Object.values(p.ratings?.['1v1']||{}),...Object.values(p.ratings?.['2v2']||{}),...Object.values(p.ratings?.['3v3']||{}));MOUNT_CATALOGUE.filter(m=>m.threshold&&highest>=m.threshold).forEach(m=>{if(!p.mounts.includes(m.id))p.mounts.push(m.id);});
 p.activeMount=p.mounts.includes(p.activeMount)?p.activeMount:(p.mounts[0]||'skyhoof');return p;}
function buildMountVisual(def,preview=false){
 const g=new THREE.Group(),legs=[],illusionRings=[],animated=[];
 const elite=def.rarity==='gladiator',legend=def.rarity==='legendary',epic=def.rarity==='epic',rare=def.rarity==='rare';
 const auraBoost=elite?1.12:legend?1.18:epic?.62:rare?.24:.10;
 const bodyMat=new THREE.MeshStandardMaterial({color:def.body,emissive:def.aura,emissiveIntensity:auraBoost*.12,roughness:.52,metalness:.12});
 const trim=new THREE.MeshStandardMaterial({color:def.accent,emissive:def.accent,emissiveIntensity:auraBoost,roughness:.34,metalness:.26});
 const armour=new THREE.MeshStandardMaterial({color:elite?0x101923:legend?0x241511:0x17202a,emissive:elite?0x163747:legend?0x43200f:0x000000,emissiveIntensity:elite?.24:legend?.18:.04,roughness:.4,metalness:.7});
 const soft=(col,op=.4)=>new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:op,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide});
 const addLeg=(x,z,h=.7,thick=.06)=>{
   const leg=new THREE.Mesh(new THREE.CylinderGeometry(thick*.78,thick,h,7),bodyMat);
   leg.position.set(x,.30,z);legs.push(leg);g.add(leg);
   const hoof=new THREE.Mesh(new THREE.BoxGeometry(thick*2.1,.08,thick*2.5),armour);
   hoof.position.y=-(h/2+.03);leg.add(hoof);return leg;
 };
 const addParticleCloud=(count,size,opacity,radius,height,color=def.aura)=>{
   const positions=new Float32Array(count*3);
   for(let i=0;i<count;i++){const a=Math.random()*Math.PI*2,r=.28+Math.random()*radius;positions[i*3]=Math.cos(a)*r;positions[i*3+1]=.06+Math.random()*height;positions[i*3+2]=Math.sin(a)*r;}
   const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));
   const cloud=new THREE.Points(geo,new THREE.PointsMaterial({color,size,transparent:true,opacity,depthWrite:false,blending:THREE.AdditiveBlending}));
   g.add(cloud);return cloud;
 };
 const addMountFace=(pivot,kind)=>{
   if(!pivot||pivot.userData.hasFace)return;pivot.userData.hasFace=true;
   const undead=kind==='deathcharger',fiery=kind==='charger',draconic=kind==='drake',cat=kind==='sabre';
   const eyeCol=undead?0x77e6ff:fiery?0xffc05a:draconic?0xb795ff:cat?0xc6ff73:0x171d23;
   const eyeMat=new THREE.MeshStandardMaterial({color:eyeCol,emissive:(undead||fiery||draconic||cat)?eyeCol:0x000000,emissiveIntensity:(undead||fiery||draconic||cat)?.95:0,roughness:.28});
   const muzzleMat=new THREE.MeshStandardMaterial({color:undead?0xa9bbc7:fiery?0x542319:kind==='ram'?0xc7d4b9:cat?0x32273e:0x47372e,roughness:.72});
   const noseMat=new THREE.MeshStandardMaterial({color:undead?0x283440:fiery?0x291510:0x15171b,emissive:undead?0x285866:0x000000,emissiveIntensity:undead?.3:0,roughness:.56});
   const eyeSpread=draconic?.13:cat?.12:.115,eyeY=cat?.05:draconic?.06:.08,front=draconic?-.22:-.235;
   [-1,1].forEach(side=>{
     const eye=new THREE.Mesh(new THREE.SphereGeometry(draconic?.036:.03,7,6),eyeMat);eye.position.set(side*eyeSpread,eyeY,front);pivot.add(eye);
     if(cat){const whisker=new THREE.Mesh(new THREE.BoxGeometry(.22,.008,.008),new THREE.MeshBasicMaterial({color:0xd2c6dd}));whisker.position.set(side*.17,-.075,-.24);whisker.rotation.z=side*.16;pivot.add(whisker);}
   });
   const muzzle=new THREE.Mesh(new THREE.SphereGeometry(draconic?.08:.095,8,6),muzzleMat);muzzle.scale.set(draconic?1.35:1,.72,.44);muzzle.position.set(0,-.06,draconic?-.235:-.25);pivot.add(muzzle);
   const nose=new THREE.Mesh(new THREE.SphereGeometry(draconic?.045:.05,7,5),noseMat);nose.scale.set(1,.65,.34);nose.position.set(0,-.045,draconic?-.285:-.295);pivot.add(nose);
   const mouth=new THREE.Mesh(new THREE.BoxGeometry(draconic?.13:.14,.012,.012),noseMat);mouth.position.set(0,-.125,draconic?-.276:-.285);pivot.add(mouth);
 };
 let headPivot=new THREE.Group(),particles=null;

 if(def.model==='courser'){
   const body=new THREE.Mesh(new THREE.CapsuleGeometry(.34,1.04,5,10),bodyMat);body.rotation.x=Math.PI/2;body.position.set(0,.79,0);g.add(body);
   const chest=new THREE.Mesh(new THREE.SphereGeometry(.36,12,10),bodyMat);chest.position.set(0,.84,-.46);chest.scale.set(.94,1.06,1.16);g.add(chest);
   const neck=new THREE.Mesh(new THREE.CylinderGeometry(.10,.16,.72,8),bodyMat);neck.position.set(0,1.11,-.72);neck.rotation.x=-.55;g.add(neck);
   headPivot.position.set(0,1.42,-.98);g.add(headPivot);
   const head=new THREE.Mesh(new THREE.BoxGeometry(.26,.22,.40),bodyMat);headPivot.add(head);
   [-.085,.085].forEach(x=>{const ear=new THREE.Mesh(new THREE.ConeGeometry(.035,.13,5),bodyMat);ear.position.set(x,.15,-.04);headPivot.add(ear);});
   [-.2,.2].forEach(x=>{addLeg(x,-.46,.76,.058);addLeg(x,.42,.76,.058);});
   const saddle=new THREE.Mesh(new THREE.BoxGeometry(.48,.12,.42),armour);saddle.position.set(0,1.13,.03);g.add(saddle);
   const cloth=new THREE.Mesh(new THREE.BoxGeometry(.52,.26,.62),new THREE.MeshStandardMaterial({color:0x39516b,roughness:.65}));cloth.position.set(0,.97,.04);g.add(cloth);
   const mane=new THREE.Mesh(new THREE.PlaneGeometry(.10,.62),new THREE.MeshStandardMaterial({color:0x35251d,roughness:.8,side:THREE.DoubleSide}));mane.position.set(0,1.20,-.57);g.add(mane);
   const tail=new THREE.Mesh(new THREE.ConeGeometry(.065,.58,7),trim);tail.position.set(0,.92,.79);tail.rotation.x=-.9;g.add(tail);
 }
 if(def.model==='sabre'){
   const torso=new THREE.Mesh(new THREE.CapsuleGeometry(.34,1.26,6,12),bodyMat);torso.rotation.x=Math.PI/2;torso.position.set(0,.67,.03);torso.scale.set(1,.78,1);g.add(torso);
   const shoulder=new THREE.Mesh(new THREE.SphereGeometry(.34,12,10),bodyMat);shoulder.position.set(0,.68,-.55);shoulder.scale.set(1,.88,1.12);g.add(shoulder);
   headPivot.position.set(0,.86,-.95);g.add(headPivot);
   const head=new THREE.Mesh(new THREE.SphereGeometry(.25,10,8),bodyMat);head.scale.set(1,.75,1.2);headPivot.add(head);
   [-.16,.16].forEach(x=>{const ear=new THREE.Mesh(new THREE.ConeGeometry(.08,.18,5),bodyMat);ear.position.set(x,.17,0);headPivot.add(ear);});
   [-.08,.08].forEach(x=>{const fang=new THREE.Mesh(new THREE.ConeGeometry(.018,.16,5),trim);fang.position.set(x,-.16,-.17);headPivot.add(fang);});
   [-.25,.25].forEach(x=>{const front=addLeg(x,-.48,.6,.062);front.rotation.x=-.20;const rear=addLeg(x,.46,.57,.068);rear.rotation.x=.22;});
   const saddle=new THREE.Mesh(new THREE.BoxGeometry(.48,.1,.48),armour);saddle.position.set(0,.98,.02);g.add(saddle);
   const tailRoot=new THREE.Group();tailRoot.position.set(0,.72,.74);g.add(tailRoot);
   const tailA=new THREE.Mesh(new THREE.CylinderGeometry(.04,.07,.52,7),bodyMat);tailA.rotation.x=-1.08;tailRoot.add(tailA);
   const tailB=new THREE.Mesh(new THREE.CylinderGeometry(.025,.04,.45,7),trim);tailB.position.set(0,.22,.25);tailB.rotation.x=-.55;tailRoot.add(tailB);animated.push(tailRoot);
   const eyeL=new THREE.Mesh(new THREE.SphereGeometry(.025,6,6),soft(def.aura,.75)),eyeR=eyeL.clone();eyeL.position.set(-.1,.04,-.23);eyeR.position.set(.1,.04,-.23);headPivot.add(eyeL,eyeR);
   particles=addParticleCloud(10,.045,.38,.54,.68,def.aura);
 }
 if(def.model==='ram'){
   const woolMat=new THREE.MeshStandardMaterial({color:def.body,roughness:.92,metalness:0});
   const wool=new THREE.Mesh(new THREE.SphereGeometry(.58,12,10),woolMat);wool.position.set(0,.78,.04);wool.scale.set(.9,.88,1.3);g.add(wool);
   const shoulder=new THREE.Mesh(new THREE.SphereGeometry(.46,10,10),woolMat);shoulder.position.set(0,.85,-.44);g.add(shoulder);
   headPivot.position.set(0,.92,-.95);g.add(headPivot);
   const head=new THREE.Mesh(new THREE.BoxGeometry(.34,.32,.42),bodyMat);headPivot.add(head);
   [-1,1].forEach(side=>{const horn=new THREE.Mesh(new THREE.TorusGeometry(.22,.055,8,22,Math.PI*1.62),trim);horn.position.set(side*.18,.03,0);horn.rotation.y=side*Math.PI/2;headPivot.add(horn);});
   [-.28,.28].forEach(x=>{addLeg(x,-.36,.56,.08);addLeg(x,.38,.56,.08);});
   const blanket=new THREE.Mesh(new THREE.BoxGeometry(.76,.12,.74),new THREE.MeshStandardMaterial({color:0x21483c,emissive:0x15362f,emissiveIntensity:.18,roughness:.7}));blanket.position.set(0,1.23,.06);g.add(blanket);
   const gem=new THREE.Mesh(new THREE.OctahedronGeometry(.08),trim);gem.position.set(0,1.25,-.38);g.add(gem);animated.push(gem);
   particles=addParticleCloud(14,.04,.32,.5,.75,0x67e7ae);
 }

 if(def.model==='protodrake'){
   const hide=new THREE.MeshStandardMaterial({color:def.body,emissive:def.hideEmissive||def.aura,emissiveIntensity:.30,roughness:.50,metalness:.12});
   const bellyMat=new THREE.MeshStandardMaterial({color:def.belly||0xdfefff,emissive:def.aura,emissiveIntensity:.18,roughness:.56,metalness:.08});
   const plate=new THREE.MeshStandardMaterial({color:def.accent,emissive:def.aura,emissiveIntensity:.50,roughness:.28,metalness:.78});
   const darkPlate=new THREE.MeshStandardMaterial({color:0x202531,emissive:def.hideEmissive||0x070b12,emissiveIntensity:.20,roughness:.42,metalness:.76});
   const crystal=soft(def.aura,.68);
   const glowMat=new THREE.MeshBasicMaterial({color:def.aura,transparent:true,opacity:.38,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});

   // Low proto-drake profile: heavy chest, long plated back, squat hips.
   const chest=new THREE.Mesh(new THREE.SphereGeometry(.70,18,14),hide);chest.position.set(0,.86,-.32);chest.scale.set(1.22,.82,1.28);g.add(chest);
   const mid=new THREE.Mesh(new THREE.CapsuleGeometry(.42,.86,8,12),hide);mid.rotation.x=Math.PI/2;mid.position.set(0,.76,.18);mid.scale.set(1.12,.82,1.0);g.add(mid);
   const hips=new THREE.Mesh(new THREE.SphereGeometry(.56,16,12),hide);hips.position.set(0,.72,.76);hips.scale.set(1.05,.70,1.12);g.add(hips);
   const belly=new THREE.Mesh(new THREE.CapsuleGeometry(.24,.92,6,10),bellyMat);belly.rotation.x=Math.PI/2;belly.position.set(0,.58,.25);belly.scale.set(1.20,.55,1);g.add(belly);

   const neck=new THREE.Mesh(new THREE.CapsuleGeometry(.20,.48,6,10),hide);neck.rotation.x=-.83;neck.position.set(0,1.02,-.78);neck.scale.set(1.0,1.0,1.25);g.add(neck);
   headPivot.position.set(0,1.12,-1.18);headPivot.rotation.x=-.08;g.add(headPivot);
   const skull=new THREE.Mesh(new THREE.SphereGeometry(.34,14,10),hide);skull.scale.set(1.25,.72,1.35);headPivot.add(skull);
   const snout=new THREE.Mesh(new THREE.CapsuleGeometry(.13,.42,6,8),hide);snout.rotation.x=Math.PI/2;snout.position.set(0,-.03,-.38);snout.scale.set(1.45,.75,1);headPivot.add(snout);
   const jaw=new THREE.Mesh(new THREE.BoxGeometry(.44,.08,.30),darkPlate);jaw.position.set(0,-.17,-.38);headPivot.add(jaw);
   [-.19,.19].forEach(x=>{const eye=new THREE.Mesh(new THREE.SphereGeometry(.042,8,6),new THREE.MeshBasicMaterial({color:def.aura}));eye.position.set(x,.035,-.48);headPivot.add(eye);});
   [-.18,.18].forEach(x=>{const horn=new THREE.Mesh(new THREE.ConeGeometry(.055,.42,6),plate);horn.position.set(x,.23,-.06);horn.rotation.x=-.55;horn.rotation.z=x>0?-.16:.16;headPivot.add(horn);});
   const noseSpike=new THREE.Mesh(new THREE.ConeGeometry(.065,.42,6),plate);noseSpike.position.set(0,.02,-.68);noseSpike.rotation.x=-Math.PI/2;headPivot.add(noseSpike);
   [-.13,.13].forEach(x=>{const fang=new THREE.Mesh(new THREE.ConeGeometry(.026,.17,5),plate);fang.position.set(x,-.21,-.50);fang.rotation.x=Math.PI;headPivot.add(fang);});

   // Large armoured shoulders/ankles, closer to the reference mount.
   [-.36,.36].forEach(x=>{
    const front=addLeg(x,-.42,.58,.09);front.material=hide;front.rotation.x=-.13;
    const rear=addLeg(x,.56,.52,.095);rear.material=hide;rear.rotation.x=.17;
    const shoulder=new THREE.Mesh(new THREE.BoxGeometry(.34,.16,.28),darkPlate);shoulder.position.set(x,.95,-.46);shoulder.rotation.z=x>0?-.12:.12;g.add(shoulder);
    const cuff=new THREE.Mesh(new THREE.BoxGeometry(.28,.12,.24),plate);cuff.position.set(x,.38,-.46);g.add(cuff);
    const rearCuff=new THREE.Mesh(new THREE.BoxGeometry(.30,.13,.25),darkPlate);rearCuff.position.set(x,.36,.52);g.add(rearCuff);
   });

   // Crystal spine and plate line.
   for(let i=0;i<10;i++){
    const z=-.72+i*.20,scale=1.0-Math.abs(i-4)*.055;
    const spine=new THREE.Mesh(new THREE.ConeGeometry(.07*scale,.30*scale,5),plate);
    spine.position.set(0,1.34-i*.035,z);spine.rotation.x=.32;g.add(spine);
    const halo=new THREE.Mesh(new THREE.RingGeometry(.10*scale,.13*scale,10),crystal);halo.position.set(0,spine.position.y-.03,z);halo.rotation.x=-Math.PI/2;g.add(halo);illusionRings.push(halo);
   }
   [-1,1].forEach(side=>{
    const wingRoot=new THREE.Group();wingRoot.position.set(side*.54,1.00,.18);g.add(wingRoot);
    const arm=new THREE.Mesh(new THREE.CylinderGeometry(.035,.060,.76,7),plate);arm.rotation.z=side*.95;arm.rotation.x=.18;wingRoot.add(arm);
    const membrane=new THREE.Mesh(new THREE.PlaneGeometry(.70,.95,1,1),glowMat);membrane.position.set(side*.21,-.06,.16);membrane.rotation.z=side*.62;membrane.rotation.x=.30;membrane.scale.set(1.05,1.0,1);wingRoot.add(membrane);
    const tip=new THREE.Mesh(new THREE.ConeGeometry(.07,.28,5),plate);tip.position.set(side*.52,.18,.03);tip.rotation.z=side*.8;wingRoot.add(tip);
    animated.push(wingRoot);
   });
   // Long plated tail
   for(let i=0;i<8;i++){
    const r=.23-i*.018;
    const seg=new THREE.Mesh(new THREE.ConeGeometry(Math.max(.07,r),.34,8),hide);
    seg.position.set(0,.67-i*.025,1.02+i*.24);seg.rotation.x=-1.08;g.add(seg);
    if(i%2===0){const blade=new THREE.Mesh(new THREE.ConeGeometry(.045,.20,5),plate);blade.position.set(0,.92-i*.03,1.04+i*.24);blade.rotation.x=.3;g.add(blade);}
   }
   const tailBlade=new THREE.Mesh(new THREE.ConeGeometry(.11,.46,6),plate);tailBlade.position.set(0,.44,2.95);tailBlade.rotation.x=-1.38;g.add(tailBlade);

   // Extra gladiator armour pass: layered jaw, chest, rib and tail plates.
   const brow=new THREE.Mesh(new THREE.BoxGeometry(.52,.09,.18),darkPlate);brow.position.set(0,.17,-.30);headPivot.add(brow);
   const facePlate=new THREE.Mesh(new THREE.BoxGeometry(.34,.07,.30),plate);facePlate.position.set(0,.06,-.53);headPivot.add(facePlate);
   for(let i=0;i<5;i++){
    const z=-.46+i*.26;
    const leftPlate=new THREE.Mesh(new THREE.BoxGeometry(.34,.075,.22),i%2?plate:darkPlate);leftPlate.position.set(-.48,1.02-i*.025,z);leftPlate.rotation.z=.38;leftPlate.rotation.y=.18;g.add(leftPlate);
    const rightPlate=new THREE.Mesh(new THREE.BoxGeometry(.34,.075,.22),i%2?plate:darkPlate);rightPlate.position.set(.48,1.02-i*.025,z);rightPlate.rotation.z=-.38;rightPlate.rotation.y=-.18;g.add(rightPlate);
   }
   for(let i=0;i<4;i++){
    const chestSpikeL=new THREE.Mesh(new THREE.ConeGeometry(.055,.28,5),plate);chestSpikeL.position.set(-.62,.92,-.58+i*.18);chestSpikeL.rotation.z=.95;g.add(chestSpikeL);
    const chestSpikeR=new THREE.Mesh(new THREE.ConeGeometry(.055,.28,5),plate);chestSpikeR.position.set(.62,.92,-.58+i*.18);chestSpikeR.rotation.z=-.95;g.add(chestSpikeR);
   }
   const chestGuard=new THREE.Mesh(new THREE.BoxGeometry(.82,.12,.52),darkPlate);chestGuard.position.set(0,1.05,-.30);chestGuard.rotation.x=.04;g.add(chestGuard);
   const glowingChestGem=new THREE.Mesh(new THREE.OctahedronGeometry(.105),crystal);glowingChestGem.position.set(0,1.13,-.58);g.add(glowingChestGem);animated.push(glowingChestGem);
   for(let i=0;i<6;i++){
    const tailPlate=new THREE.Mesh(new THREE.BoxGeometry(.24-i*.018,.055,.16),i%2?darkPlate:plate);tailPlate.position.set(0,.78-i*.025,1.06+i*.24);tailPlate.rotation.x=-.18;g.add(tailPlate);
   }
   const saddle=new THREE.Mesh(new THREE.BoxGeometry(.62,.14,.52),darkPlate);saddle.position.set(0,1.17,.02);g.add(saddle);
   const crown=new THREE.Mesh(new THREE.OctahedronGeometry(.16),plate);crown.position.set(0,1.48,-.63);g.add(crown);animated.push(crown);
   const auraRing=new THREE.Mesh(new THREE.TorusGeometry(.42,.020,6,34),crystal);auraRing.position.copy(crown.position);auraRing.rotation.x=Math.PI/2;g.add(auraRing);illusionRings.push(auraRing);
   particles=addParticleCloud(32,.060,.50,.78,1.20,def.aura);
 }
 if(def.model==='aetherwyrm'){
   const hide=new THREE.MeshStandardMaterial({color:def.body,emissive:def.hideEmissive||0x221036,emissiveIntensity:.34,roughness:.44,metalness:.16});
   const silver=new THREE.MeshStandardMaterial({color:def.armourPrimary||0xc8d5de,emissive:def.armourPrimary||0x223845,emissiveIntensity:.18,roughness:.33,metalness:.76});
   const dark=new THREE.MeshStandardMaterial({color:def.armourDark||0x313b46,emissive:def.armourDark||0x151c25,emissiveIntensity:.18,roughness:.42,metalness:.70});
   const violet=soft(def.wingGlow||0x8666e8,.44);
   const glow=soft(def.eyeGlow||def.aura,.78);

   // More dragon, less sausage: separate chest, abdomen and hips instead of one long capsule.
   const chest=new THREE.Mesh(new THREE.SphereGeometry(.78,16,12),hide);
   chest.position.set(0,1.02,-.45);chest.scale.set(1.05,.82,.92);g.add(chest);

   const ribs=new THREE.Mesh(new THREE.BoxGeometry(1.05,.48,.82),hide);
   ribs.position.set(0,.95,.12);ribs.rotation.x=.05;g.add(ribs);

   const hips=new THREE.Mesh(new THREE.SphereGeometry(.56,14,10),hide);
   hips.position.set(0,.82,.82);hips.scale.set(1.0,.68,.82);g.add(hips);

   const belly=new THREE.Mesh(new THREE.CapsuleGeometry(.30,.78,8,10),hide);
   belly.rotation.x=Math.PI/2;belly.position.set(0,.86,.48);belly.scale.set(1.15,.80,.75);g.add(belly);

   const neck=new THREE.Mesh(new THREE.CapsuleGeometry(.20,.88,8,10),hide);
   neck.rotation.x=-.70;neck.position.set(0,1.22,-1.05);g.add(neck);

   headPivot.position.set(0,1.48,-1.62);g.add(headPivot);
   const skull=new THREE.Mesh(new THREE.BoxGeometry(.82,.48,.66),hide);skull.position.set(0,.04,0);headPivot.add(skull);
   const snout=new THREE.Mesh(new THREE.BoxGeometry(.54,.28,.70),hide);snout.position.set(0,-.04,-.58);headPivot.add(snout);
   const brow=new THREE.Mesh(new THREE.BoxGeometry(.92,.14,.22),silver);brow.position.set(0,.22,-.40);headPivot.add(brow);
   const jaw=new THREE.Mesh(new THREE.BoxGeometry(.74,.14,.78),dark);jaw.position.set(0,-.22,-.50);headPivot.add(jaw);
   const chin=new THREE.Mesh(new THREE.ConeGeometry(.10,.42,8),silver);chin.position.set(0,-.40,-.65);chin.rotation.x=Math.PI;headPivot.add(chin);

   [-.34,.34].forEach(x=>{
    const horn=new THREE.Mesh(new THREE.ConeGeometry(.075,.78,10),silver);horn.position.set(x,.30,-.20);horn.rotation.x=-1.02;horn.rotation.z=x>0?-.16:.16;headPivot.add(horn);
    const cheek=new THREE.Mesh(new THREE.ConeGeometry(.065,.36,8),dark);cheek.position.set(x,.00,-.50);cheek.rotation.z=x>0?-1.20:1.20;headPivot.add(cheek);
    const eye=new THREE.Mesh(new THREE.SphereGeometry(.060,8,6),glow);eye.position.set(x*.55,.06,-.68);headPivot.add(eye);
   });

   // Shoulder / neck plates like the screenshot.
   for(let i=0;i<6;i++){
    const plate=new THREE.Mesh(new THREE.BoxGeometry(.62-i*.045,.075,.20),silver);
    plate.position.set(0,1.32-i*.015,-.90+i*.26);plate.rotation.x=-.10;g.add(plate);
   }
   [-.42,.42].forEach(x=>{
    const shoulder=new THREE.Mesh(new THREE.ConeGeometry(.18,.42,5),silver);
    shoulder.position.set(x,1.18,-.55);shoulder.rotation.z=x>0?-.55:.55;g.add(shoulder);
   });

   const tail=new THREE.Mesh(new THREE.CapsuleGeometry(.16,1.26,8,10),hide);
   tail.rotation.x=-1.08;tail.position.set(0,.68,1.42);g.add(tail);
   const tailBlade=new THREE.Mesh(new THREE.ConeGeometry(.20,.55,4),silver);
   tailBlade.position.set(0,.42,2.12);tailBlade.rotation.x=-1.25;g.add(tailBlade);

   for(let i=0;i<8;i++){
    const spine=new THREE.Mesh(new THREE.ConeGeometry(.075,.30,5),silver);
    spine.position.set(0,1.26-i*.035,.60-i*.24);spine.rotation.x=Math.PI;g.add(spine);
   }

   // Longer legs and claws make it read less like a tube.
   [[-.50,-.55,.95,.12],[.50,-.55,.95,.12],[-.52,.62,.90,.12],[.52,.62,.90,.12]].forEach(([x,z,h,t])=>{
    addLeg(x,z,h,t);
    const cuff=new THREE.Mesh(new THREE.TorusGeometry(.17,.030,6,16),silver);cuff.position.set(x,.39,z);cuff.rotation.x=Math.PI/2;g.add(cuff);
    const claw=new THREE.Mesh(new THREE.ConeGeometry(.055,.24,6),silver);claw.position.set(x,.07,z-.13);claw.rotation.x=-Math.PI/2;g.add(claw);
   });

   // Big angular violet wings. PlaneGeometry is much cheaper than complex custom shapes.
   [-1,1].forEach(side=>{
    const wing=new THREE.Group();
    const root=new THREE.Mesh(new THREE.CapsuleGeometry(.055,1.35,6,8),dark);root.rotation.z=side*.95;root.position.set(side*.78,1.28,.02);wing.add(root);
    const outer=new THREE.Mesh(new THREE.CapsuleGeometry(.045,1.05,6,8),dark);outer.rotation.z=side*.40;outer.position.set(side*1.36,1.03,.22);wing.add(outer);
    const membrane=new THREE.Mesh(new THREE.PlaneGeometry(1.35,.82,1,1),violet);
    membrane.position.set(side*1.00,.88,.55);membrane.rotation.set(-Math.PI/2,0,side*.28);membrane.scale.x=side;wing.add(membrane);
    animated.push(wing);g.add(wing);
   });

   const saddle=new THREE.Mesh(new THREE.BoxGeometry(.86,.18,.72),dark);saddle.position.set(0,1.40,.02);g.add(saddle);
   const saddleTrim=new THREE.Mesh(new THREE.BoxGeometry(.96,.07,.82),silver);saddleTrim.position.set(0,1.53,.02);g.add(saddleTrim);
   const chestPlate=new THREE.Mesh(new THREE.BoxGeometry(1.10,.16,.34),silver);chestPlate.position.set(0,1.16,-.78);chestPlate.rotation.x=-.12;g.add(chestPlate);

   const auraRing=new THREE.Mesh(new THREE.TorusGeometry(1.72,.035,8,72),soft(def.aura,.42));auraRing.position.set(0,.13,0);auraRing.rotation.x=Math.PI/2;illusionRings.push(auraRing);g.add(auraRing);
   addParticleCloud(preview?42:58,.052,.70,1.42,1.30,def.aura);
  }else if(def.model==='drake'){
   const scaleMat=new THREE.MeshStandardMaterial({color:def.body,emissive:0x312550,emissiveIntensity:.35,roughness:.38,metalness:.32});
   const torso=new THREE.Mesh(new THREE.CapsuleGeometry(.34,1.24,5,10),scaleMat);torso.rotation.x=Math.PI/2;torso.position.set(0,.82,.12);g.add(torso);
   const chest=new THREE.Mesh(new THREE.SphereGeometry(.36,10,10),scaleMat);chest.position.set(0,.89,-.48);g.add(chest);
   const neck=new THREE.Mesh(new THREE.CylinderGeometry(.10,.17,.63,8),scaleMat);neck.position.set(0,1.08,-.72);neck.rotation.x=-.62;g.add(neck);
   headPivot.position.set(0,1.34,-1.01);g.add(headPivot);
   const snout=new THREE.Mesh(new THREE.ConeGeometry(.19,.48,6),scaleMat);snout.rotation.x=-Math.PI/2;headPivot.add(snout);
   [-.21,.21].forEach(x=>{addLeg(x,-.43,.52,.052);addLeg(x,.4,.52,.052);});
   [-1,1].forEach(side=>{const wing=new THREE.Mesh(new THREE.ConeGeometry(.34,.9,5),new THREE.MeshStandardMaterial({color:def.accent,emissive:def.aura,emissiveIntensity:.58,transparent:true,opacity:.72,side:THREE.DoubleSide}));wing.position.set(side*.46,1.03,.08);wing.rotation.z=side*.7;g.add(wing);animated.push(wing);});
   for(let i=0;i<4;i++){const tailSeg=new THREE.Mesh(new THREE.ConeGeometry(.12-i*.02,.35,6),scaleMat);tailSeg.position.set(0,.8,.79+i*.25);tailSeg.rotation.x=-.95;g.add(tailSeg);}
   const stormOrb=new THREE.Mesh(new THREE.OctahedronGeometry(.09),trim);stormOrb.position.set(0,1.62,-.56);g.add(stormOrb);animated.push(stormOrb);
   const coil=new THREE.Mesh(new THREE.TorusGeometry(.28,.018,6,24),soft(def.aura,.47));coil.rotation.x=Math.PI/2;coil.position.copy(stormOrb.position);g.add(coil);illusionRings.push(coil);
   particles=addParticleCloud(26,.062,.52,.68,1.35,def.aura);
 }
 if(def.model==='charger'){
   const torso=new THREE.Mesh(new THREE.CapsuleGeometry(.43,1.18,6,12),bodyMat);torso.rotation.x=Math.PI/2;torso.position.set(0,.84,.02);g.add(torso);
   const chest=new THREE.Mesh(new THREE.SphereGeometry(.48,12,10),bodyMat);chest.position.set(0,.89,-.5);chest.scale.set(1,1,1.16);g.add(chest);
   const neck=new THREE.Mesh(new THREE.CylinderGeometry(.14,.22,.74,9),bodyMat);neck.position.set(0,1.2,-.78);neck.rotation.x=-.5;g.add(neck);
   headPivot.position.set(0,1.5,-1.04);g.add(headPivot);
   const helm=new THREE.Mesh(new THREE.BoxGeometry(.42,.33,.46),armour);headPivot.add(helm);
   const faceFlame=new THREE.Mesh(new THREE.ConeGeometry(.10,.33,7),trim);faceFlame.position.set(0,.2,-.04);headPivot.add(faceFlame);
   [-.27,.27].forEach(x=>{const a=addLeg(x,-.5,.8,.075),b=addLeg(x,.45,.8,.075);[a,b].forEach(leg=>{const fire=new THREE.Mesh(new THREE.SphereGeometry(.11,8,8),soft(def.aura,.48));fire.position.y=-.42;leg.add(fire);animated.push(fire);});});
   const saddle=new THREE.Mesh(new THREE.BoxGeometry(.62,.17,.54),armour);saddle.position.set(0,1.28,.04);g.add(saddle);
   [-1,1].forEach(side=>{const flank=new THREE.Mesh(new THREE.BoxGeometry(.11,.46,.7),armour);flank.position.set(side*.43,.96,0);g.add(flank);const rune=new THREE.Mesh(new THREE.BoxGeometry(.116,.045,.46),trim);rune.position.set(side*.49,.99,-.06);g.add(rune);});
   const moltenMane=new THREE.Mesh(new THREE.PlaneGeometry(.22,.88),soft(def.aura,.38));moltenMane.position.set(0,1.4,-.66);g.add(moltenMane);animated.push(moltenMane);
   const fireRing=new THREE.Mesh(new THREE.TorusGeometry(1.12,.045,8,38),soft(def.aura,.26));fireRing.rotation.x=Math.PI/2;fireRing.position.y=.08;g.add(fireRing);illusionRings.push(fireRing);
   particles=addParticleCloud(38,.082,.62,.86,1.55,def.aura);
 }
 if(def.model==='deathcharger'){
   const boneMat=new THREE.MeshStandardMaterial({color:0x141b26,emissive:0x102531,emissiveIntensity:.22,roughness:.44,metalness:.56});
   const spine=new THREE.Mesh(new THREE.CapsuleGeometry(.3,1.08,5,10),boneMat);spine.rotation.x=Math.PI/2;spine.position.set(0,.84,.02);g.add(spine);
   for(let i=0;i<4;i++){const rib=new THREE.Mesh(new THREE.TorusGeometry(.35-i*.018,.04,7,18,Math.PI),armour);rib.rotation.z=Math.PI/2;rib.position.set(0,.9,.32-i*.18);g.add(rib);}
   const chest=new THREE.Mesh(new THREE.SphereGeometry(.38,12,10),boneMat);chest.position.set(0,.9,-.5);g.add(chest);
   const neck=new THREE.Mesh(new THREE.CylinderGeometry(.11,.18,.72,8),boneMat);neck.position.set(0,1.2,-.76);neck.rotation.x=-.54;g.add(neck);
   headPivot.position.set(0,1.49,-1.02);g.add(headPivot);
   const skull=new THREE.Mesh(new THREE.BoxGeometry(.36,.3,.44),armour);headPivot.add(skull);
   [-1,1].forEach(side=>{const horn=new THREE.Mesh(new THREE.ConeGeometry(.05,.32,6),trim);horn.position.set(side*.18,.16,.02);horn.rotation.z=-side*.36;headPivot.add(horn);});
   [-.25,.25].forEach(x=>{const front=addLeg(x,-.47,.79,.062),rear=addLeg(x,.43,.79,.062);[front,rear].forEach(leg=>{const ghost=new THREE.Mesh(new THREE.SphereGeometry(.12,8,8),soft(def.aura,.37));ghost.position.y=-.43;leg.add(ghost);animated.push(ghost);});});
   const armourBack=new THREE.Mesh(new THREE.BoxGeometry(.68,.16,.65),armour);armourBack.position.set(0,1.24,.05);g.add(armourBack);
   [-1,1].forEach(side=>{const pauldron=new THREE.Mesh(new THREE.BoxGeometry(.18,.28,.32),armour);pauldron.position.set(side*.4,1.13,-.37);g.add(pauldron);});
   const ghostMane=new THREE.Mesh(new THREE.PlaneGeometry(.27,.92),soft(def.aura,.23));ghostMane.position.set(0,1.39,-.63);g.add(ghostMane);animated.push(ghostMane);
   const spectralRing=new THREE.Mesh(new THREE.TorusGeometry(1.15,.032,8,38),soft(def.aura,.16));spectralRing.rotation.x=Math.PI/2;spectralRing.position.y=.1;g.add(spectralRing);illusionRings.push(spectralRing);
   const upperRing=new THREE.Mesh(new THREE.TorusGeometry(.65,.02,8,32),soft(def.aura,.1));upperRing.rotation.x=Math.PI/2;upperRing.position.y=1.12;g.add(upperRing);illusionRings.push(upperRing);
   particles=addParticleCloud(54,.085,.52,.78,1.78,def.aura);
 }
 addMountFace(headPivot,def.model);
  if(def.model==='sabre'){
   const haunch=new THREE.Mesh(new THREE.SphereGeometry(.28,10,8),bodyMat);haunch.position.set(0,.66,.52);haunch.scale.set(1.15,.75,.9);g.add(haunch);
   const chestPlate=new THREE.Mesh(new THREE.BoxGeometry(.56,.10,.30),armour);chestPlate.position.set(0,.92,-.62);g.add(chestPlate);
   [-.32,.32].forEach(x=>{const shoulderCap=new THREE.Mesh(new THREE.ConeGeometry(.09,.22,5),trim);shoulderCap.position.set(x,.84,-.48);shoulderCap.rotation.z=x>0?-.6:.6;g.add(shoulderCap);});
  }
  if(def.model==='ram'){
   const rump=new THREE.Mesh(new THREE.SphereGeometry(.42,10,8),new THREE.MeshStandardMaterial({color:def.body,roughness:.92,metalness:0}));rump.position.set(0,.76,.55);rump.scale.set(.95,.75,.9);g.add(rump);
   const browPlate=new THREE.Mesh(new THREE.BoxGeometry(.42,.08,.20),trim);browPlate.position.set(0,1.03,-.99);g.add(browPlate);
  }
  if(def.model==='drake'){
   const hip=new THREE.Mesh(new THREE.SphereGeometry(.28,10,8),new THREE.MeshStandardMaterial({color:def.body,emissive:0x312550,emissiveIntensity:.24,roughness:.4,metalness:.25}));hip.position.set(0,.74,.58);hip.scale.set(1.05,.68,.88);g.add(hip);
   const jawPlate=new THREE.Mesh(new THREE.BoxGeometry(.36,.08,.32),armour);jawPlate.position.set(0,1.25,-1.18);g.add(jawPlate);
   const saddlePlate=new THREE.Mesh(new THREE.BoxGeometry(.55,.08,.48),trim);saddlePlate.position.set(0,1.08,.02);g.add(saddlePlate);
  }
  if(def.model==='deathcharger'){
   const rearArmour=new THREE.Mesh(new THREE.BoxGeometry(.56,.13,.36),armour);rearArmour.position.set(0,1.10,.50);g.add(rearArmour);
   const faceGuard=new THREE.Mesh(new THREE.BoxGeometry(.42,.08,.22),trim);faceGuard.position.set(0,1.58,-1.17);g.add(faceGuard);
  }
 if(def.skinFx==='void'||def.skinFx==='ascendant'){
   const fxColour=def.skinFx==='void'?0xff003f:0xffd000;
   const fxAccent=def.skinFx==='void'?0x7d35ff:0xffffbf;
   const halo1=new THREE.Mesh(new THREE.TorusGeometry(1.32,.018,8,52),soft(fxColour,.36));
   halo1.rotation.x=Math.PI/2;halo1.position.y=.22;g.add(halo1);illusionRings.push(halo1);
   const halo2=new THREE.Mesh(new THREE.TorusGeometry(1.58,.014,8,58),soft(fxAccent,.25));
   halo2.rotation.x=Math.PI/2;halo2.rotation.z=.8;halo2.position.y=.56;g.add(halo2);illusionRings.push(halo2);
   const halo3=new THREE.Mesh(new THREE.TorusGeometry(.82,.012,8,44),soft(fxAccent,.32));
   halo3.rotation.x=Math.PI/2;halo3.rotation.z=-.55;halo3.position.y=1.36;g.add(halo3);illusionRings.push(halo3);
   addParticleCloud(preview?72:46,def.skinFx==='void'?.055:.06,.42,1.62,1.55,fxColour);
   const crown=new THREE.Mesh(new THREE.OctahedronGeometry(.16),new THREE.MeshBasicMaterial({color:fxAccent,transparent:true,opacity:.88,depthWrite:false,blending:THREE.AdditiveBlending}));
   crown.position.set(0,1.95,-.35);g.add(crown);animated.push(crown);
  }/* MOUNT_SKIN_3000_FX */
  const ringOpacity=elite?.22:legend?.28:epic?.2:rare?.08:.035;
 const ring=new THREE.Mesh(new THREE.RingGeometry(1.02,1.2,36),soft(def.aura,ringOpacity));ring.rotation.x=-Math.PI/2;ring.position.y=.02;g.add(ring);
 if(def.threshold){const light=new THREE.PointLight(def.aura,preview?(elite?1.65:2.0):(elite?.72:.88),5.5);light.position.set(0,1,.1);g.add(light);}
 g.rotation.y=Math.PI;g.scale.setScalar(def.scale);
 g.userData={legs,headPivot,ring,particles,illusionRings,animated,definition:def,tickFX:(time,dt)=>{
   if(particles){particles.rotation.y+=dt*(def.model==='drake'?1.15:def.model==='charger'?.66:def.model==='deathcharger'?.46:.34);particles.position.y=Math.sin(time*2.4)*.04;}
   illusionRings.forEach((obj,i)=>{obj.rotation.z+=dt*(i%2?.3:-.3);obj.rotation.y+=dt*(i%2?-.38:.38);});
   animated.forEach((obj,i)=>{const pulse=.86+.16*Math.sin(time*(2.3+i*.16)+i);obj.scale.setScalar(pulse);});
   if(def.model==='drake'&&animated.length){animated.slice(0,2).forEach((wing,i)=>{wing.rotation.z=(i?1:-1)*(.66+.1*Math.sin(time*3.4));});}
    if(def.model==='aetherwyrm'&&animated.length){animated.forEach((wing,i)=>{const side=i?1:-1;wing.rotation.z=side*(.06+.04*Math.sin(time*2.0));});}if(def.skinFx){ring.material.opacity=(def.skinFx==='ascendant'?.32:.26)+Math.sin(time*3.2)*.05;animated.forEach((obj,i)=>{if(i>1)obj.rotation.y+=dt*(def.skinFx==='void'?1.35:1.05);});}/* MOUNT_SKIN_3000_TICK */
 }};
 return g;
}




function aetherLearnTalentChoice(cls,node,tree,state,rank,nodeCanLearn){
 if(!node)return;
 const optionIds=node.virtualChoice?node.optionIds:null;
 const siblings=optionIds?optionIds.map(id=>tree.find(n=>n.id===id)).filter(Boolean):(node.choice?tree.filter(n=>n.choice===node.choice):[node]);
 const commit=n=>{
  if(!n||!nodeCanLearn(n))return;
  if(n.choice)tree.filter(x=>x.choice===n.choice&&x.id!==n.id).forEach(x=>{delete state[x.id];});
  state[n.id]=(state[n.id]||0)+1;
  if(typeof saveProgression==='function')saveProgression();syncTalentUnlockedAbilities();if(window.game&&game.renderActions)game.renderActions();
  document.querySelector('.talent-choice-backdrop')?.remove();
  aetherBasicTalentTree(cls);
 };
 if((node.virtualChoice||(node.choice&&!node.inlineChoice))&&siblings.length>1){
  const backdrop=document.createElement('div');
  backdrop.className='talent-choice-backdrop';
  backdrop.innerHTML=`<div class="talent-choice-card"><h3>${talentIcon(node)} ${node.choiceLabel||node.name||'Choose a Talent'}</h3><p>This is a choice node. Pick one branch option. You can reset or right-click learned nodes later to rebuild freely.</p><div class="talent-choice-grid">${siblings.map(n=>{const can=nodeCanLearn(n),r=rank(n.id);return `<button class="talent-choice-option" data-choice-id="${n.id}" ${can?'':'disabled'}><strong>${talentIcon(n)} ${n.name}</strong>${n.desc}<small>Rank ${r}/${n.max}${can?' · Available':r>0?' · Learned / maxed':' · Locked'}</small></button>`;}).join('')}</div><div class="talent-choice-actions"><button class="minor-btn" data-choice-close>Cancel</button></div></div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('[data-choice-close]').onclick=()=>{if(window.game&&game.audio)game.audio.play('menu');backdrop.remove();};
  backdrop.querySelectorAll('[data-choice-id]').forEach(b=>b.onclick=()=>{if(window.game&&game.audio)game.audio.play('menu');commit(siblings.find(n=>n.id===b.dataset.choiceId));});
  return;
 }
 commit(node);
}
function talentPresetProfiles(cls){
 if(cls==='soul')return[
  {id:'affliction',label:'Affliction',icon:'🟣',prefer:['pandemic','soul_pandemic_bloom','soul_horror','soul_curse_weaving'],exclude:new Set(['souldrain','soul_void_mend'])},
  {id:'chaos',label:'Chaos',icon:'🟢',prefer:['souldrain','soul_void_mend','soul_dark_pact','soul_barrier_rites','soul_summon_infernal'],exclude:new Set(['pandemic','soul_pandemic_bloom'])}
 ];
 return[{id:'default',label:'Default Build',icon:'✨',prefer:[],exclude:new Set()}];
}
function applyTalentPreset(cls,profile,pointBudget){
 const tree=TALENT_TREES[cls]||[],state={},rank=id=>Number(state[id]||0),excluded=profile?.exclude||new Set(),preferred=new Map((profile?.prefer||[]).map((id,i)=>[id,i]));
 const ordered=tree.filter(node=>!node.virtualChoice&&!excluded.has(node.id)).slice().sort((a,b)=>{
  const pa=preferred.has(a.id)?preferred.get(a.id):-1,pb=preferred.has(b.id)?preferred.get(b.id):-1;
  if(pa>=0||pb>=0){if(pa<0)return 1;if(pb<0)return-1;if(pa!==pb)return pa-pb;}
  return (a.y||0)-(b.y||0)||(a.x||0)-(b.x||0);
 });
 let spent=0,progress=true;
 while(spent<pointBudget&&progress){progress=false;for(const node of ordered){
  if(spent>=pointBudget)break;if(rank(node.id)>=(node.max||1))continue;
  if(node.req?.length&&!node.req.some(id=>rank(id)>0))continue;
  if(node.choice&&tree.some(other=>other.choice===node.choice&&other.id!==node.id&&rank(other.id)>0))continue;
  if(talentCapstoneBlocked(tree,rank,node))continue;
  state[node.id]=rank(node.id)+1;spent++;progress=true;
 }}
 progression.talents=progression.talents||{};progression.talents[cls]=state;saveProgression();syncTalentUnlockedAbilities();
 if(window.game?.renderActions)game.renderActions();
 if(window.game?.message)game.message(`${CLASS_INFO[cls]?.name||cls}: ${profile.label} preset equipped`);
}
function aetherBasicTalentTree(cls='flame'){
 syncTalentUnlockedAbilities();
 cls=(window.TALENT_TREES&&TALENT_TREES[cls])?cls:'flame';
 const tree=(window.TALENT_TREES&&TALENT_TREES[cls])||TALENT_TREES.flame;
 const metaMap=(typeof CLASS_INFO!=='undefined'?CLASS_INFO:(typeof CLASSES!=='undefined'?CLASSES:{}));
 const safeProgress=(typeof progression!=='undefined'?progression:(window.progression||(window.game&&window.game.progression)||{}));
 safeProgress.talents=safeProgress.talents&&typeof safeProgress.talents==='object'?safeProgress.talents:{};
 safeProgress.talents[cls]=safeProgress.talents[cls]||{};
 const state=safeProgress.talents[cls];
 const rank=id=>Number(state[id]||0);
 const spent=Object.values(state).reduce((a,b)=>a+(Number(b)||0),0);
 const ratingForTalents=(typeof classRating==='function'?Math.max(classRating(cls,'2v2'),classRating(cls,'3v3')):1600);const earned=Math.max(26,Math.min(48,26+Math.floor(Math.max(0,ratingForTalents-1600)/90)+Math.floor(((safeProgress.wins||0))/30)));
 const avail=Math.max(0,earned-spent);
 const modal=document.querySelector('#talents'),tabs=document.querySelector('#talentTabs'),wrap=document.querySelector('#talentTree'),info=document.querySelector('#talentInfo');
 if(!modal||!tabs||!wrap||!info)return;
 modal.classList.remove('hidden');
 const classLabel=document.querySelector('#talentClassLabel'),pa=document.querySelector('#talentPointsAvailable'),ps=document.querySelector('#talentPointsSpent');
 if(classLabel)classLabel.textContent=metaMap[cls]?.name||cls;
 if(pa)pa.textContent=avail;
 if(ps)ps.textContent=`${spent} / ${earned}`;
 const classes=(typeof GEAR_CLASSES!=='undefined'&&GEAR_CLASSES.length?GEAR_CLASSES:Object.keys(TALENT_TREES));
 tabs.innerHTML=classes.map(c=>`<button class="${c===cls?'active':''}" data-basic-talent-class="${c}"><span class="talent-class-icon">${classIcon(c,metaMap[c]?.badge||'✦')}</span>${metaMap[c]?.name||c}<br><small>${Object.values((safeProgress.talents&&safeProgress.talents[c])||{}).reduce((a,b)=>a+(Number(b)||0),0)} spent</small></button>`).join('');
 tabs.querySelectorAll('[data-basic-talent-class]').forEach(b=>b.onclick=()=>aetherBasicTalentTree(b.dataset.basicTalentClass));
 const presetActions=document.querySelector('#talentPresetActions');if(presetActions){const profiles=talentPresetProfiles(cls);presetActions.innerHTML=`<span>Premade ${cls==='soul'?'builds':'build'}</span><div>${profiles.map(profile=>`<button class="minor-btn" data-talent-preset="${profile.id}">${profile.icon} ${profile.label}</button>`).join('')}</div>`;presetActions.querySelectorAll('[data-talent-preset]').forEach(button=>button.onclick=()=>{const profile=profiles.find(item=>item.id===button.dataset.talentPreset);if(!profile)return;applyTalentPreset(cls,profile,earned);aetherBasicTalentTree(cls);});}
 const nodeCanLearn=node=>{
  if(!node||node.virtualChoice)return false;
  if(rank(node.id)>=node.max||avail<=0)return false;
  if(node.req&&node.req.length&&!node.req.some(id=>rank(id)>0))return false;
  if(node.choice&&tree.some(n=>n.choice===node.choice&&n.id!==node.id&&rank(n.id)>0))return false;
  if(talentCapstoneBlocked(tree,rank,node))return false;
  return true;
 };
 const pruneInvalidTalents=()=>{
  let changed=true;
  while(changed){
   changed=false;
   tree.forEach(n=>{
    if(!rank(n.id))return;
    if(n.req&&n.req.length&&!n.req.some(id=>rank(id)>0)){delete state[n.id];changed=true;}
    if(n.choice){
     const learned=tree.filter(x=>x.choice===n.choice&&rank(x.id)>0);
     learned.slice(1).forEach(x=>{delete state[x.id];changed=true;});
    }
    if(pruneTalentCapstoneOverflow(tree,state))changed=true;
   });
  }
 };
 const groupedChoices={};
 tree.forEach(n=>{if(n.choice){(groupedChoices[n.choice]||(groupedChoices[n.choice]=[])).push(n);}});
 const hiddenOptionIds=new Set();
 const virtualNodes=[];
 Object.entries(groupedChoices).forEach(([choice,nodes])=>{
  if(nodes.length<2||nodes.some(n=>n.inlineChoice))return;
  nodes.forEach(n=>hiddenOptionIds.add(n.id));
  const learned=nodes.find(n=>rank(n.id)>0);
  const first=nodes[0];
  const req=Array.from(new Set(nodes.flatMap(n=>n.req||[])));
  const avgX=nodes.reduce((a,n)=>a+n.x,0)/nodes.length,avgY=nodes.reduce((a,n)=>a+n.y,0)/nodes.length;
  virtualNodes.push({id:`choice_${choice}`,virtualChoice:true,choice,optionIds:nodes.map(n=>n.id),name:first.choiceLabel||'Choice Node',choiceLabel:first.choiceLabel||'Choose a Talent',icon:learned?learned.icon:(first.choiceIcon||'✦'),x:avgX,y:avgY,max:Math.max(...nodes.map(n=>n.max||1)),req,desc:first.choiceDesc||'Choose one of the options in this branch.'});
 });
 const displayNodes=tree.filter(n=>!hiddenOptionIds.has(n.id)).concat(virtualNodes);
 const nodeById=id=>displayNodes.find(n=>n.id===id)||virtualNodes.find(v=>v.optionIds&&v.optionIds.includes(id))||tree.find(n=>n.id===id);
 const displayRank=n=>n.virtualChoice?n.optionIds.reduce((a,id)=>a+rank(id),0):rank(n.id);
 const displayMax=n=>n.virtualChoice?Math.max(...n.optionIds.map(id=>tree.find(x=>x.id===id)?.max||1)):n.max;
 const displayLearned=n=>displayRank(n)>0;
 const displayCanLearn=n=>n.virtualChoice?n.optionIds.some(id=>nodeCanLearn(tree.find(x=>x.id===id))):nodeCanLearn(n);
 const lines=displayNodes.flatMap(n=>(n.req||[]).map(req=>{const a=nodeById(req);if(!a)return'';const learned=displayLearned(n)&&displayLearned(a);return `<line x1="${a.x}%" y1="${a.y}%" x2="${n.x}%" y2="${n.y}%" stroke="${learned?'#7dff8b':'rgba(210,190,140,.30)'}" stroke-width="${learned?3:2}"/>`;})).join('');
 wrap.innerHTML=`<svg class="talent-lines">${lines}</svg>`+displayNodes.map(n=>{const r=displayRank(n),max=displayMax(n),learned=r>0,can=displayCanLearn(n);return `<button class="talent-node ${n.capstone?'capstone-node':n.unlockAbility?'unlock-node':'passive-node'} ${(n.choice&&!n.inlineChoice)||n.virtualChoice?'choice choicehub':''} ${learned?'learned refundable':can?'available':'locked'}" style="left:${n.x}%;top:${n.y}%;" data-basic-talent="${n.id}"><span class="talent-icon">${talentIcon(n)}</span><span class="talent-rank">${r}/${max}</span></button>`;}).join('');
 let selected=displayNodes[0];
 const drawInfo=node=>{
  selected=node;
  const r=displayRank(node),max=displayMax(node),can=displayCanLearn(node),req=(node.req||[]).map(id=>tree.find(n=>n.id===id)?.name).filter(Boolean).join(' or ');
  const capstoneNote=node.capstoneGroup?`Capstone: you may learn any ${node.capstoneLimit||2} nodes from this row.<br>`:'';
  const altNames=node.inlineChoice?tree.filter(n=>n.choice===node.choice&&n.id!==node.id).map(n=>n.name):[];
  const choiceNote=altNames.length?`Choice: learning this locks ${altNames.join(' and ')}.<br>`:'';
  info.innerHTML=`<div class="talent-name">${talentIcon(node)} ${node.name}</div><div class="talent-desc">${node.desc}</div><div class="talent-status">Rank: <strong>${r}/${max}</strong><br>${capstoneNote}${choiceNote}${node.unlockAbility?(node.replaceAbility?`Active ability replacement: learning this replaces ${node.replaceAbility} in the same action-bar slot.<br>`:'Active ability unlock: learning this adds a new button to your action bar.<br>'):node.virtualChoice?'Choice node: click to choose between branch options.<br>':node.choice?'Choice node: only one option in this branch can be active.<br>':''}${req?`Requires: ${req}<br>`:''}${can?'Left-click this node to learn.':r>=max?'Max rank learned.':'Locked or no points available.'}<br>${r>0?'Right-click this node to refund one rank.':''}</div>`;
  const learn=document.querySelector('#learnTalentBtn');if(learn)learn.disabled=!can;
 };
 wrap.querySelectorAll('[data-basic-talent]').forEach(btn=>{
  const node=displayNodes.find(n=>n.id===btn.dataset.basicTalent);
  btn.onclick=()=>{if(window.game&&game.audio)game.audio.play('menu');drawInfo(node);if(displayCanLearn(node))aetherLearnTalentChoice(cls,node,tree,state,rank,nodeCanLearn);};
  btn.onmouseenter=()=>drawInfo(node);
  btn.oncontextmenu=e=>{e.preventDefault();if(window.game&&game.audio)game.audio.play('menu');if(displayRank(node)>0){if(node.virtualChoice){const learned=node.optionIds.find(id=>rank(id)>0);if(learned){state[learned]=Math.max(0,rank(learned)-1);if(state[learned]<=0)delete state[learned];}}else{state[node.id]=Math.max(0,rank(node.id)-1);if(state[node.id]<=0)delete state[node.id];}pruneInvalidTalents();if(typeof saveProgression==='function')saveProgression();syncTalentUnlockedAbilities();if(window.game&&game.renderActions)game.renderActions();document.getElementById('talentTip')?.remove();aetherBasicTalentTree(cls);}};
  btn.ondblclick=()=>aetherLearnTalentChoice(cls,node,tree,state,rank,nodeCanLearn);
  btn.onmousemove=e=>{
   let tip=document.getElementById('talentTip');if(!tip){tip=document.createElement('div');tip.id='talentTip';tip.className='talent-tooltip';document.body.appendChild(tip);}
   const can=displayCanLearn(node),r=displayRank(node),max=displayMax(node),req=(node.req||[]).map(id=>tree.find(n=>n.id===id)?.name).filter(Boolean).join(' or ');
   const options=node.virtualChoice?`<div class="tip-cost">Options: ${node.optionIds.map(id=>{const opt=tree.find(n=>n.id===id);return `${opt.icon} ${opt.name}`;}).join(' / ')}</div>`:'';
   tip.style.left=Math.min(innerWidth-365,e.clientX+18)+'px';tip.style.top=Math.min(innerHeight-190,e.clientY+18)+'px';
   tip.innerHTML=`<h4>${talentIcon(node)} ${node.name}</h4><p>${node.desc}</p><div class="tip-rank">Rank ${r}/${max}${node.unlockAbility?(node.replaceAbility?' · Ability Replacement':' · Active Ability'):node.virtualChoice?' · Choice Node':node.choice?' · Choice Option':''}</div>${node.capstoneGroup?`<div class="tip-cost">Capstone row: pick any ${node.capstoneLimit||2}.</div>`:''}${node.inlineChoice?`<div class="tip-cost">Choice: ${tree.filter(n=>n.choice===node.choice).map(n=>n.name).join(' or ')}</div>`:''}${node.replaceAbility?`<div class="tip-cost">Replaces: ${node.replaceAbility}</div>`:''}${options}${req?`<div class="tip-cost">Requires: ${req}</div>`:''}<div class="tip-cost">${can?'<span class="tip-good">Available:</span> left-click to learn.':r>0?'<span class="tip-good">Learned:</span> right-click to refund one rank.':'<span class="tip-bad">Locked:</span> missing prerequisite, choice conflict or points.'}</div>`;
  };
  btn.onmouseleave=()=>document.getElementById('talentTip')?.remove();
 });
 const learn=document.querySelector('#learnTalentBtn');
 if(learn)learn.onclick=()=>aetherLearnTalentChoice(cls,selected,tree,state,rank,nodeCanLearn);
 const reset=document.querySelector('#resetTalentsBtn');
 if(reset)reset.onclick=()=>{if(!confirm('Reset this class talent tree?'))return;safeProgress.talents[cls]={};if(typeof saveProgression==='function')saveProgression();syncTalentUnlockedAbilities();if(window.game&&game.renderActions)game.renderActions();aetherBasicTalentTree(cls);};
 drawInfo(selected);
}
const TALENT_TREES={
 disc:[
  {id:'disc_devotion',name:'Penitent Devotion',icon:'✦',x:50,y:8,max:3,desc:'Increase all Discipline healing by 3% per rank.',effects:{healingPct:3}},
  {id:'disc_focused_will',name:'Focused Will',icon:'🤍',x:28,y:24,max:2,req:['disc_devotion'],desc:'Increase stamina by 3% per rank.',effects:{staminaPct:3}},
  {id:'disc_shielding',name:'Shield Discipline',icon:'🔵',x:72,y:24,max:2,req:['disc_devotion'],desc:'Power Shield absorbs 6% more per rank.'},
  {id:'disc_evangelism',name:'Evangelism',icon:'📖',x:50,y:40,max:2,req:['disc_focused_will','disc_shielding'],desc:'Increase Atonement duration by 1 second per rank.'},
  {id:'disc_archangel',name:'Archangel',icon:'🪽',x:36,y:57,max:1,req:['disc_evangelism'],choice:'disc_archangel_choice',choiceLabel:'Angelic Alignment',choiceIcon:'✦',choiceDesc:'Choose Archangel for stronger Atonement healing or Dark Archangel for stronger offensive pressure.',unlockAbility:true,desc:'Unlock Archangel: increase Atonement healing by 30% for 12 sec and manifest small white priest wings.'},
  {id:'disc_dark_archangel',name:'Dark Archangel',icon:'🖤',x:64,y:57,max:1,req:['disc_evangelism'],choice:'disc_archangel_choice',choiceLabel:'Angelic Alignment',choiceIcon:'✦',choiceDesc:'Choose Archangel for stronger Atonement healing or Dark Archangel for stronger offensive pressure.',unlockAbility:true,desc:'Unlock Dark Archangel: increase Discipline damage by 30% for 12 sec and manifest dark violet priest wings.'},
  {id:'disc_penance',name:'Penitent Bolts',icon:'🌠',x:24,y:73,max:2,req:['disc_archangel','disc_dark_archangel'],desc:'Penance Atonement healing is increased by 6% per rank.'},
  {id:'disc_angelic_body',name:'Angelic Body',icon:'💨',x:50,y:75,max:1,req:['disc_archangel','disc_dark_archangel'],unlockAbility:true,desc:'Unlock Angelic Body: gain 30% additional movement speed for 5 sec on a 30 sec cooldown.'},
  {id:'disc_radiance',name:'Radiant Last Resort',icon:'🌟',x:76,y:73,max:2,req:['disc_archangel','disc_dark_archangel'],desc:'Ultimate Radiance healing is increased by 6% per rank.'},
  {id:'disc_solace',name:'Solace of the Light',icon:'☀️',x:18,y:91,max:2,req:['disc_penance'],desc:'Solace restores 2 additional mana per rank.'},
  {id:'disc_pain',name:'Unbreakable Faith',icon:'🕊️',x:50,y:92,max:2,req:['disc_penance','disc_radiance'],desc:'Reduce Pain Suppression cooldown by 3 seconds per rank.'},
  {id:'disc_darklight',name:'Twilight Conversion',icon:'🌓',x:82,y:91,max:2,req:['disc_radiance'],desc:'Shadow Mend heals 4% more per rank.'}
 ],
 flame:[{id:'emberfocus',name:'Ember Focus',icon:'🔥',x:50,y:8,max:3,desc:'Cinder Bolt and Ember Lance deal 3% more damage per rank.',effects:{damagePct:3},wind_paralysis:{name:'Paralysis',icon:'💫',type:'windIncap',school:'wind',range:18,cast:0,cd:32,cost:16,value:3.5,tip:'Talent ability. Ranged incapacitate.'},wind_chi_burst:{name:'Chi Burst',icon:'🟢',type:'damage',school:'wind',range:24,cast:0,cd:16,cost:10,value:145,tip:'Talent ability. Ranged wind pressure.'}},{id:'swiftstep',name:'Swift Blazing Step',icon:'💨',x:32,y:22,max:2,req:['emberfocus'],desc:'Reduces Blazing Step cooldown by 1 second per rank. Blazing Step remains usable while casting Cinder Bolt or Prism Hex.'},{id:'hexmastery',name:'Prism Control',icon:'🐑',x:68,y:22,max:2,req:['emberfocus'],desc:'Reduces Prism Hex cast time by 0.10 seconds per rank, making crowd-control setups faster and harder to stop.'},{id:'meteorchoice',name:'Meteor Path',icon:'☄️',x:50,y:38,max:1,req:['swiftstep','hexmastery'],desc:'Unlocks the Meteor specialisation choice node below.'},{id:'meteorimpact',name:'Meteor Impact',icon:'💥',x:36,y:56,max:2,req:['meteorchoice'],choice:'flame_final',choiceLabel:'Meteor Specialisation',choiceIcon:'☄️',choiceDesc:'Choose whether your Flame Duelist build focuses on Meteor Lance burst or Counterflare resource tempo.',desc:'Meteor Lance deals 4% increased damage per rank. This bonus applies to the rapid empowered Ember Lances triggered after Meteorfall.'},{id:'counterheat',name:'Counterheat',icon:'🔶',x:64,y:56,max:2,req:['meteorchoice'],choice:'flame_final',choiceLabel:'Meteor Specialisation',choiceIcon:'☄️',choiceDesc:'Choose whether your Flame Duelist build focuses on Meteor Lance burst or Counterflare resource tempo.',desc:'After Counterflare successfully interrupts a cast, restore 3 additional mana per rank on top of the normal refund.'},{id:'flame_meteor_spear',name:'Meteor Spear',icon:'🌠',x:36,y:76,max:1,req:['meteorimpact'],unlockAbility:true,desc:'Unlocks Meteor Spear: an instant 24m fire nuke on an 18 second cooldown that fits into Meteor Lance burst windows.'},{id:'flame_phoenix_guard',name:'Phoenix Guard',icon:'🛡️',x:64,y:76,max:1,req:['counterheat'],unlockAbility:true,desc:'Unlocks Phoenix Guard: a situational defensive button that reduces incoming damage during setup or counter-pressure.'},{id:'flame_overheat',name:'Overheat',icon:'♨️',x:22,y:62,max:2,req:['meteorchoice'],desc:'After using a talent fire ability, your next Cinder Bolt deals 2% more damage per rank.'},{id:'flame_tempered_focus',name:'Tempered Focus',icon:'🎯',x:78,y:62,max:2,req:['meteorchoice'],desc:'Casting while pressured grants 2% reduced damage taken per rank for 2 sec.'},{id:'flame_inferno_wave',name:'Inferno Wave',icon:'🌊',x:22,y:82,max:1,req:['meteorimpact'],unlockAbility:true,desc:'Unlocks Inferno Wave: close-range fire pressure around your current target.'},{id:'flame_cauterize',name:'Cauterize',icon:'❤️‍🔥',x:78,y:82,max:1,req:['counterheat'],unlockAbility:true,desc:'Unlocks Cauterize: a small emergency self-heal.'}],
 warrior:[{id:'warlust',name:'War Lust',icon:'⚔️',x:50,y:8,max:3,desc:'Increases Warrior direct damage by 3% per rank, affecting Mortal Swing, Rend, Charge and Gushing Wound.',effects:{damagePct:3}},{id:'deepwounds',name:'Deep Wounds',icon:'🩸',x:32,y:25,max:2,req:['warlust'],desc:'Increases Rend and Gushing Wound bleed tick damage by 5% per rank.'},{id:'ironwall',name:'Iron Wall',icon:'🛡️',x:68,y:25,max:2,req:['warlust'],desc:'Reduces Shield Wall cooldown by 3 seconds per rank. Shield Wall still reduces damage taken by 60% and damage dealt by 25% while active.'},{id:'brutalchoice',name:'Warrior Doctrine',icon:'🪓',x:50,y:43,max:1,req:['deepwounds','ironwall'],desc:'Unlocks the Warrior doctrine choice node below.'},{id:'executioner',name:'Executioner',icon:'💀',x:36,y:62,max:2,req:['brutalchoice'],choice:'war_final',choiceLabel:'Warrior Doctrine',choiceIcon:'🪓',choiceDesc:'Choose between stronger execute pressure or improved survival while low health.',desc:'Mortal Swing deals 5% increased damage per rank to targets below 35% health.'},{id:'battlehardened',name:'Battle Hardened',icon:'🏰',x:64,y:62,max:2,req:['brutalchoice'],choice:'war_final',choiceLabel:'Warrior Doctrine',choiceIcon:'🪓',choiceDesc:'Choose between stronger execute pressure or improved survival while low health.',desc:'While below 45% health, reduce damage taken by 3% per rank.'},{id:'war_execute_strike',name:'Stormbolt',icon:'🔮',x:36,y:82,max:1,req:['executioner'],unlockAbility:true,desc:'Unlocks Stormbolt: hurl a violet missile up to 22m that stuns for 3 sec on a 25 sec cooldown.'},{id:'war_rallying_wall',name:'Sharpen Blade',icon:'🗡️',x:64,y:82,max:1,req:['battlehardened'],unlockAbility:true,desc:'Unlocks Sharpen Blade: your next Mortal Swing reduces healing received by 40% for 3 sec while healing you for 3% maximum health each second, ignoring dampening.'},{id:'war_pummel_chain',name:'Pummel Chain',icon:'⛓️',x:22,y:62,max:2,req:['brutalchoice'],desc:'Interrupting a cast increases your next Mortal Swing damage by 2% per rank.'},{id:'war_hold_the_line',name:'Hold the Line',icon:'🧱',x:78,y:62,max:2,req:['brutalchoice'],desc:'After Charge, gain 2% damage reduction per rank for 3 sec.'},{id:'war_skullbreaker',name:'Avatar',icon:'🗿',x:22,y:82,max:1,req:['executioner'],unlockAbility:true,desc:'Unlocks Avatar: a 50 sec offensive cooldown that increases all damage by 18% for 10 sec and removes an active root when pressed.'},{id:'war_battle_banner',name:'Intercept',icon:'🛡️',x:78,y:82,max:1,req:['battlehardened'],unlockAbility:true,desc:'Unlocks Intercept: charge to an ally and redirect all their incoming damage to yourself for 4 sec on a 25 sec cooldown.'}],
 storm:[{id:'stormamp',name:'Charged Core',icon:'⚡',x:50,y:8,max:3,desc:'Stormwarden damage increased by 2% per rank.',effects:{damagePct:2}},{id:'surgeflow',name:'Surge Flow',icon:'🌩️',x:32,y:25,max:2,req:['stormamp'],desc:'Increases the Storm Surge failed-roll ramp by 1% per rank, making Storm Surge more reliable over repeated Arc Sparks.'},{id:'windfocus',name:'Wind Focus',icon:'🌪️',x:68,y:25,max:2,req:['stormamp'],desc:'Reduces Wind Shear cooldown by 1 second per rank.'},{id:'overloadpath',name:'Overload Path',icon:'🔱',x:50,y:43,max:1,req:['surgeflow','windfocus'],desc:'Unlocks the Stormwarden overload choice node below.'},{id:'lavacore',name:'Lava Core',icon:'🌋',x:36,y:62,max:2,req:['overloadpath'],choice:'storm_final',choiceLabel:'Overload Specialisation',choiceIcon:'🔱',choiceDesc:'Choose between stronger overload burst or extra stability while casting.',desc:'Volcanic Overload, Forked Current, Volcanic Eruption and Tempest Bolt deal 4% increased damage per rank.'},{id:'grounded',name:'Grounded Casting',icon:'🛡️',x:64,y:62,max:2,req:['overloadpath'],choice:'storm_final',choiceLabel:'Overload Specialisation',choiceIcon:'🔱',choiceDesc:'Choose between stronger overload burst or extra stability while casting.',desc:'Taking damage while casting has a small chance to restore 2 mana. This is a sustain/control path.'},{id:'storm_lava_burst',name:'Volcanic Eruption',icon:'🌋',x:36,y:82,max:1,req:['lavacore'],unlockAbility:true,desc:'Unlocks Volcanic Eruption: Skybreaker Pulse readies one instant ranged eruption.'},{id:'storm_grounding_aegis',name:'Grounding Aegis',icon:'🌀',x:64,y:82,max:1,req:['grounded'],unlockAbility:true,desc:'Unlocks Grounding Aegis: a strong personal shield for surviving melee connection while continuing pressure.'},{id:'storm_arc_battery',name:'Arc Battery',icon:'🔋',x:22,y:62,max:2,req:['overloadpath'],desc:'Arc Spark refunds 1 extra mana per rank when Storm Surge triggers.'},{id:'storm_aftershock',name:'Aftershock',icon:'📡',x:78,y:62,max:2,req:['overloadpath'],desc:'After interrupting with Wind Shear, your next spell deals 2% more damage per rank.'},{id:'storm_static_field',name:'Static Field',icon:'🧲',x:22,y:82,max:1,req:['grounded'],unlockAbility:true,desc:'Unlocks Static Field: root/control utility.'},{id:'storm_chain_spark',name:'Healing Surge',icon:'🔗',x:78,y:82,max:1,req:['lavacore'],unlockAbility:true,desc:'Unlocks Healing Surge: a strong casted heal for yourself or an ally.'}],
 soul:[{id:'soulpressure',name:'Withering Pressure',icon:'🟣',x:50,y:8,max:3,desc:'Soulweaver damage over time and direct shadow pressure increase by 3% per rank.',effects:{damagePct:3}},{id:'gloomreach',name:'Long Gloom',icon:'🕸️',x:32,y:25,max:2,req:['soulpressure'],desc:'Increases Grasping Gloom range by 1m per rank.'},{id:'drainrite',name:'Drain Rite',icon:'🩸',x:68,y:25,max:2,req:['soulpressure'],desc:'Essence Siphon healing increased by 4% per rank.'},{id:'cursepath',name:'Curse Path',icon:'☠️',x:50,y:43,max:1,req:['gloomreach','drainrite'],desc:'Unlocks the Soulweaver curse choice node below.'},{id:'pandemic',name:'Pandemic Spread',icon:'🧪',x:36,y:62,max:2,req:['cursepath'],choice:'soul_final',choiceLabel:'Curse Specialisation',choiceIcon:'☠️',choiceDesc:'Choose between wider curse pressure or stronger single-target sustain damage.',desc:'Affliction pressure deals 4% more damage per rank when two or more enemies are affected by your damage-over-time effects.'},{id:'souldrain',name:'Soul Drain',icon:'💜',x:64,y:62,max:2,req:['cursepath'],choice:'soul_final',choiceLabel:'Curse Specialisation',choiceIcon:'☠️',choiceDesc:'Choose between wider curse pressure or stronger single-target sustain damage.',desc:'Essence Siphon and single-target shadow damage are 4% stronger per rank.'},{id:'soul_pandemic_bloom',name:'Pandemic Bloom',icon:'🧫',x:36,y:82,max:1,req:['pandemic'],unlockAbility:true,desc:'Unlocks Pandemic Bloom: an instant shadow burst button that rewards maintaining pressure across enemies.'},{id:'soul_void_mend',name:'Void Mend',icon:'💗',x:64,y:82,max:1,req:['souldrain'],unlockAbility:true,desc:'Unlocks Void Mend: a defensive drain-style button that damages an enemy and helps stabilise yourself.'},{id:'soul_curse_weaving',name:'Curse Weaving',icon:'🪬',x:22,y:62,max:2,req:['cursepath'],desc:'Reapplying afflictions increases your next shadow hit by 2% per rank.'},{id:'soul_barrier_rites',name:'Barrier Rites',icon:'🔮',x:78,y:62,max:2,req:['cursepath'],desc:'Your shadow shields are 3% stronger per rank.'},{id:'soul_horror',name:'Mortal Horror',icon:'😱',x:22,y:82,max:1,req:['pandemic'],unlockAbility:true,desc:'Unlocks Mortal Horror: a short fear for kill setups.'},{id:'soul_dark_pact',name:'Dark Pact',icon:'🕳️',x:78,y:82,max:1,req:['souldrain'],unlockAbility:true,desc:'Unlocks Dark Pact: a powerful self-shield.'}],
 sage:[{id:'lifebloom',name:'Lifebloom Study',icon:'🌿',x:50,y:8,max:3,desc:'Increases all healing done by 2% per rank.',effects:{healingPct:2}},{id:'quickmend',name:'Quick Mend',icon:'💧',x:32,y:25,max:2,req:['lifebloom'],desc:'Reduces your primary healing cast time by 0.08 seconds per rank.'},{id:'cleanhands',name:'Clean Hands',icon:'✨',x:68,y:25,max:2,req:['lifebloom'],desc:'Reduces Cleanse cooldown by 0.5 seconds per rank.'},{id:'sagepath',name:'Sage Path',icon:'🌸',x:50,y:43,max:1,req:['quickmend','cleanhands'],desc:'Unlocks the Lifesage path choice node below.'},{id:'wildgrowth',name:'Wild Growth',icon:'🌱',x:36,y:62,max:2,req:['sagepath'],choice:'sage_final',choiceLabel:'Sage Specialisation',choiceIcon:'🌸',choiceDesc:'Choose between stronger throughput or better defensive safety.',desc:'Healing done to allies below 45% health is increased by 4% per rank.'},{id:'barkskin',name:'Barkskin Discipline',icon:'🪵',x:64,y:62,max:2,req:['sagepath'],choice:'sage_final',choiceLabel:'Sage Specialisation',choiceIcon:'🌸',choiceDesc:'Choose between stronger throughput or better defensive safety.',desc:'Your defensive cooldowns are more reliable and reduce incoming pressure during swaps.'},{id:'sage_spirit_bloom',name:'Ironbark',icon:'🌳',x:36,y:82,max:1,req:['wildgrowth'],unlockAbility:true,desc:'Unlocks Ironbark: reduce damage taken by yourself or an ally by 20% for 6 sec on a 30 sec cooldown.'},{id:'sage_verdant_tempo',name:'Verdant Tempo',icon:'🍃',x:22,y:62,max:2,req:['sagepath'],desc:'Healing over time ticks are 3% stronger per rank.'},{id:'sage_root_warden',name:'Root Warden',icon:'🪵',x:78,y:62,max:2,req:['sagepath'],desc:'Your peel tools recover 2 seconds faster per rank.'},{id:'sage_natures_grasp',name:'Nature’s Grasp',icon:'🌾',x:22,y:82,max:1,req:['barkskin'],unlockAbility:true,desc:'Unlocks Nature’s Grasp: root an enemy to peel pressure.'},{id:'sage_rejuvenate',name:'Rejuvenate',icon:'🌺',x:78,y:82,max:1,req:['wildgrowth'],unlockAbility:true,desc:'Unlocks Rejuvenate: an instant heal-over-time talent, now 20% stronger.'}],
 pala:[{id:'holytraining',name:'Holy Training',icon:'☀️',x:50,y:8,max:3,desc:'Increases all healing done by 2% per rank.',effects:{healingPct:2}},{id:'fastlight',name:'Fast Light',icon:'💡',x:32,y:25,max:2,req:['holytraining'],desc:'Reduces Holy Light cast time by 0.08 seconds per rank.'},{id:'steadfast',name:'Steadfast Steed',icon:'🐎',x:68,y:25,max:2,req:['holytraining'],desc:'Reduces Divine Steed cooldown by 2 seconds per rank.'},{id:'palpath',name:'Paladin Path',icon:'🛡️',x:50,y:43,max:1,req:['fastlight','steadfast'],desc:'Unlocks the Paladin support choice node below.'},{id:'guardianlight',name:'Guardian Light',icon:'🕯️',x:36,y:62,max:2,req:['palpath'],choice:'pala_final',choiceLabel:'Paladin Specialisation',choiceIcon:'🛡️',choiceDesc:'Choose between defensive support utility or stronger burst healing.',desc:'Blessing and protection effects are stronger during enemy burst windows.'},{id:'radiance',name:'Radiance',icon:'🌟',x:64,y:62,max:2,req:['palpath'],choice:'pala_final',choiceLabel:'Paladin Specialisation',choiceIcon:'🛡️',choiceDesc:'Choose between defensive support utility or stronger burst healing.',desc:'Holy Shock and Light of Dawn recovery windows are 4% stronger per rank.'},{id:'pala_guardian_angel',name:'Guardian Angel',icon:'👼',x:36,y:82,max:1,req:['guardianlight'],unlockAbility:true,desc:'Unlocks Guardian Angel: a strong external protective shield for saving an ally.'},{id:'pala_divine_toll',name:'Divine Toll',icon:'🔔',x:64,y:82,max:1,req:['radiance'],unlockAbility:true,desc:'Unlocks Divine Toll: an instant holy burst spell that can heal allies or damage enemies depending on target.'},{id:'pala_sacred_vow',name:'Sacred Vow',icon:'📜',x:22,y:62,max:2,req:['palpath'],desc:'Blessing effects last 0.25 sec longer per rank.'},{id:'pala_radiant_shock',name:'Radiant Shock',icon:'✨',x:78,y:62,max:2,req:['palpath'],desc:'Holy Shock critical chance increased by 3% per rank.'},{id:'pala_freedom',name:'Blessing of Freedom',icon:'🪽',x:22,y:82,max:1,req:['guardianlight'],unlockAbility:true,desc:'Unlocks Blessing of Freedom: cleanse roots/snares/control.'},{id:'pala_judgement',name:'Judgement',icon:'⚖️',x:78,y:82,max:1,req:['radiance'],unlockAbility:true,desc:'Unlocks Judgement: ranged holy damage that restores mana on hit.'}],
  shadow:[{id:'nightedge',name:'Night Edge',icon:'🗡️',x:50,y:8,max:3,desc:'Increases Shadowblade damage by 3% per rank.',effects:{damagePct:3}},{id:'pounceflow',name:'Pounce Flow',icon:'🌑',x:32,y:25,max:2,req:['nightedge'],desc:'Reduces Umbral Pounce cooldown by 1 second per rank.'},{id:'smoketactics',name:'Smoke Tactics',icon:'💨',x:68,y:25,max:2,req:['nightedge'],desc:'Increases Smoke Bomb duration by 0.25 seconds per rank.'},{id:'roguepath',name:'Rogue Path',icon:'☠️',x:50,y:43,max:1,req:['pounceflow','smoketactics'],desc:'Unlocks the Shadowblade rogue choice node below.'},{id:'garrote',name:'Garrote Setup',icon:'🩸',x:36,y:62,max:2,req:['roguepath'],choice:'shadow_final',choiceLabel:'Shadowblade Specialisation',choiceIcon:'☠️',choiceDesc:'Choose between stronger control chains or better finishing pressure.',desc:'Crowd-control follow-up damage is increased during your opener windows.'},{id:'eviscerate',name:'Eviscerate',icon:'🔪',x:64,y:62,max:2,req:['roguepath'],choice:'shadow_final',choiceLabel:'Shadowblade Specialisation',choiceIcon:'☠️',choiceDesc:'Choose between stronger control chains or better finishing pressure.',desc:'Finishing pressure against targets below 35% health is increased by 5% per rank.'},{id:'shadow_sap',name:'Sap',icon:'😵',x:36,y:82,max:1,req:['garrote'],unlockAbility:true,desc:'Unlocks Sap: prevent an enemy from acting for 4 sec so you can create a clean setup. Damage breaks the effect.'},{id:'shadow_shadowstep',name:'Vendetta',icon:'🎯',x:64,y:82,max:1,req:['eviscerate'],unlockAbility:true,desc:'Unlocks Vendetta: an off-GCD mark that makes your rogue bleeds and poisons tick faster instead of giving a flat damage buff.'},{id:'shadow_poisoncraft',name:'Poisoncraft',icon:'🧪',x:22,y:62,max:2,req:['roguepath'],desc:'Poison and bleed pressure increased by 3% per rank.'},{id:'shadow_veil_training',name:'Veil Training',icon:'🌫️',x:78,y:62,max:2,req:['roguepath'],desc:'Defensive shadow effects last 0.25 sec longer per rank.'},{id:'shadow_crimson_vial',name:'Crimson Vial',icon:'🧪',x:22,y:82,max:1,req:['eviscerate'],unlockAbility:true,desc:'Unlocks Crimson Vial: instant self-heal defensive.'},{id:'shadow_gouge',name:'Gouge',icon:'👁️',x:78,y:82,max:1,req:['garrote'],unlockAbility:true,desc:'Unlocks Gouge: prevent a nearby enemy from acting for 2 sec. Damage breaks the effect.'}],
 wind:[{id:'flowstate',name:'Flow State',icon:'🍃',x:50,y:8,max:3,desc:'Increases Windwalker damage by 3% per rank.',effects:{damagePct:3}},{id:'longdash',name:'Long Cloudstep',icon:'🦶',x:32,y:25,max:2,req:['flowstate'],desc:'Reduces Cloudstep Kick cooldown by 1 second per rank.'},{id:'focusfury',name:'Focused Fury',icon:'🥊',x:68,y:25,max:2,req:['flowstate'],desc:'Fists of Fury deals 4% increased damage per rank.'},{id:'windpath',name:'Wind Path',icon:'🌪️',x:50,y:43,max:1,req:['longdash','focusfury'],desc:'Unlocks the Windwalker path choice node below.'},{id:'tigerdash',name:'Tiger Dash',icon:'🐅',x:36,y:62,max:2,req:['windpath'],choice:'wind_final',choiceLabel:'Windwalker Specialisation',choiceIcon:'🌪️',choiceDesc:'Choose between more mobility or stronger crowd-control setups.',desc:'Mobility and reconnect windows are improved, helping Windwalker stick to kiting targets.'},{id:'cyclonetech',name:'Cyclone Technique',icon:'🌀',x:64,y:62,max:2,req:['windpath'],choice:'wind_final',choiceLabel:'Windwalker Specialisation',choiceIcon:'🌪️',choiceDesc:'Choose between more mobility or stronger crowd-control setups.',desc:'Cyclone Barrage and setup pressure are stronger during coordinated kill attempts.'},{id:'wind_tiger_rush',name:'Tiger Rush',icon:'🐅',x:36,y:82,max:1,req:['tigerdash'],unlockAbility:true,desc:'Unlocks Tiger Rush: a second mobility strike for reconnecting without relying only on Cloudstep.'},{id:'wind_karma',name:'Touch of Karma',icon:'☯️',x:64,y:82,max:1,req:['cyclonetech'],unlockAbility:true,desc:'Unlocks Touch of Karma: a situational defensive button for surviving while staying aggressive.'},{id:'wind_nimble_brew',name:'Nimble Brew',icon:'🍶',x:22,y:62,max:2,req:['windpath'],desc:'Mobility cooldowns recover 1 second faster per rank.'},{id:'wind_temple_guard',name:'Temple Guard',icon:'☯️',x:78,y:62,max:2,req:['windpath'],desc:'Defensive martial stance is 3% stronger per rank.'},{id:'wind_paralysis',name:'Paralysis',icon:'💫',x:22,y:82,max:1,req:['cyclonetech'],unlockAbility:true,desc:'Unlocks Paralysis: ranged incapacitate setup tool.'},{id:'wind_chi_burst',name:'Cyclone Barrage',icon:'🌪️',x:78,y:82,max:1,req:['tigerdash'],unlockAbility:true,desc:'Unlocks Cyclone Barrage: melee finisher that consumes Tempest Flow for a heavier Cyclone Combo. Fists of Fury is now its own baseline ability.'}]
}

function enhanceTalentTreeNodes(){
 const add=(cls,node)=>{const arr=TALENT_TREES[cls];if(arr&&!arr.some(n=>n.id===node.id))arr.push(node);};
 const common=[
  ['flame',{id:'flame_ashen_vitality',name:'Ashen Vitality',icon:'❤️‍🔥',x:50,y:88,max:2,req:['meteorchoice'],staminaNode:true,effects:{staminaPct:3},desc:'Increases maximum health by 3% per rank. A defensive choice for Flame Duelists who want to survive swaps instead of only stacking burst.'}],
  ['warrior',{id:'war_plate_training',name:'Plate Training',icon:'🛡️',x:50,y:74,max:2,req:['brutalchoice'],staminaNode:true,effects:{staminaPct:3},desc:'Increases maximum health by 3% per rank. This gives Warrior a sturdier bruiser profile without adding more burst damage.'}],
  ['storm',{id:'storm_static_hide',name:'Static Hide',icon:'🔰',x:50,y:92,max:2,req:['overloadpath'],staminaNode:true,effects:{staminaPct:3},desc:'Increases maximum health by 3% per rank. A defensive storm path for surviving while setting up casts.'}],
  ['soul',{id:'soul_dark_resilience',name:'Dark Resilience',icon:'🖤',x:50,y:92,max:2,req:['cursepath'],staminaNode:true,effects:{staminaPct:3},desc:'Increases maximum health by 3% per rank. Helps Soulweaver survive while ramping pressure.'}],
  ['sage',{id:'sage_vital_growth',name:'Vital Growth',icon:'🌲',x:50,y:92,max:2,req:['sagepath'],staminaNode:true,effects:{staminaPct:3},desc:'Increases maximum health by 3% per rank. Useful for healers who are getting trained often.'}],
  ['pala',{id:'pala_sacred_stamina',name:'Sacred Stamina',icon:'💛',x:50,y:92,max:2,req:['palpath'],staminaNode:true,effects:{staminaPct:3},desc:'Increases maximum health by 3% per rank. A safer holy build option that does not inflate damage.'}],
  ['shadow',{id:'shadow_elusiveness',name:'Elusiveness',icon:'🕶️',x:50,y:92,max:2,req:['roguepath'],staminaNode:true,effects:{staminaPct:3},desc:'Increases maximum health by 3% per rank. Gives Shadowblade a defensive alternative to pure kill pressure.'}],
  ['wind',{id:'wind_tigers_lust',name:"Tiger's Lust",icon:'🐯',x:50,y:84,max:1,req:['windpath'],unlockAbility:true,desc:"Unlocks Tiger's Lust: remove snares and roots, then gain 70% movement speed for 4 sec."}],
  ['wind',{id:'wind_tigereye_brew',name:'Tigereye Brew',icon:'🍺',x:50,y:74,max:1,req:['windpath'],unlockAbility:false,desc:'Unlocks Tigereye Brew. Every 2 Zephyr Palms grants 2 stacks, up to 6. Consume at 2/4/6 stacks for 10%/20%/30% additional damage and healing for 6 seconds.'}],
  ['wind',{id:'wind_iron_body',name:'Iron Body',icon:'🥋',x:50,y:92,max:2,req:['windpath'],staminaNode:true,effects:{staminaPct:3},desc:'Increases maximum health by 3% per rank. A safer Windwalker path for surviving return pressure.'}]
 ];
 common.forEach(([c,n])=>add(c,n));
 [
  ['flame',{id:'flame_dragon_breath',name:'Dragon Breath',icon:'🐉',x:16,y:92,max:1,req:['flame_ashen_vitality'],unlockAbility:true,desc:'Unlocks Dragon Breath: a short-range disorient for creating a clean follow-up cast or escaping melee pressure.'}],
  ['flame',{id:'flame_molten_armor',name:'Molten Armor',icon:'🪨',x:84,y:92,max:1,req:['flame_ashen_vitality'],unlockAbility:true,desc:'Unlocks Molten Armor: a self-shield for surviving offensive swaps without increasing your burst.'}],
  ['warrior',{id:'war_heroic_leap',name:'Bladestorm',icon:'🦘',x:16,y:92,max:1,req:['war_plate_training'],unlockAbility:true,desc:'Unlocks Bladestorm: spin around dealing AoE damage and become immune to stuns, roots and slows during it.'}],
  ['warrior',{id:'war_victory_rush',name:'Victory Rush',icon:'🏆',x:50,y:92,max:1,req:['war_plate_training'],unlockAbility:true,desc:'Unlocks Victory Rush: light enemy damage and a self-heal for sustain.'}],
  ['warrior',{id:'war_disarm',name:'Warbreaker',icon:'🪃',x:84,y:92,max:1,req:['war_plate_training'],unlockAbility:true,desc:'Unlocks Warbreaker: deal damage, empower the next Mortal Swing by 30%, then trigger three rapid Slicing Winds.'}],
  ['storm',{id:'storm_thunderstep',name:'Thunderstep',icon:'👣',x:16,y:92,max:1,req:['storm_static_hide'],unlockAbility:true,desc:'Unlocks Thunderstep: a short defensive reposition that knocks nearby enemies away.'}],
  ['storm',{id:'storm_mana_well',name:'Mana Well',icon:'💧',x:84,y:92,max:1,req:['storm_static_hide'],unlockAbility:true,desc:'Unlocks Mana Well: a small sustain tool that restores resource and helps longer games.'}],
  ['soul',{id:'soul_shadowfury',name:'Shadowfury',icon:'🌑',x:16,y:92,max:1,req:['soul_dark_resilience'],unlockAbility:true,desc:'Unlocks Shadowfury: a short setup stun for creating pressure after dots are active.'}],
  ['soul',{id:'soul_dark_pact',name:'Dark Pact',icon:'🛡️',x:84,y:92,max:1,req:['soul_dark_resilience'],unlockAbility:true,desc:'Unlocks Dark Pact: a self-shield for surviving while maintaining affliction pressure.'}],
  ['soul',{id:'soul_undying_resolve',name:'Undying Resolve',icon:'🟣',x:50,y:82,max:1,req:['soul_dark_resilience'],unlockAbility:true,desc:'Unlocks Undying Resolve: a 5 sec 50% damage reduction wall for surviving committed burst. Placed in a straight line from Dark Resilience for a cleaner path.'}],
  ['soul',{id:'soul_summon_infernal',name:'Summon Infernal',icon:'🔥',x:88,y:92,max:1,req:['soul_dark_resilience'],unlockAbility:true,desc:'Unlocks Summon Infernal: aim a killable 10 sec summon that lands with area damage and a 2 sec stun, pulses nearby enemies and restores mana.'}],
  ['sage',{id:'sage_natures_grasp',name:'Nature’s Grasp',icon:'🌿',x:16,y:92,max:1,req:['sage_vital_growth'],unlockAbility:true,desc:'Unlocks Nature’s Grasp: a ranged root for peeling melee off yourself or your partner.'}],
  ['sage',{id:'sage_rejuvenating_gust',name:'Nature Swiftness',icon:'🌿',x:84,y:92,max:1,req:['sage_vital_growth'],unlockAbility:true,desc:'Replaces the old Rejuvenating Gust slot. Resets Renewal Tide on a 40 sec cooldown for a second emergency save.'}],
  ['pala',{id:'pala_word_of_glory',name:'Word of Glory',icon:'📜',x:16,y:92,max:1,req:['pala_sacred_stamina'],unlockAbility:true,desc:'Unlocks Word of Glory: an instant single-target heal for emergency recovery.'}],
  ['pala',{id:'pala_blinding_light',name:'Blinding Light',icon:'✨',x:84,y:92,max:1,req:['pala_sacred_stamina'],unlockAbility:true,desc:'Unlocks Blinding Light: a short crowd-control tool for peeling or setting up a kill.'}],
  ['shadow',{id:'shadow_shiv',name:'Shiv',icon:'🗡️',x:50,y:74,max:1,req:['shadow_elusiveness'],unlockAbility:true,desc:'Unlocks Shiv: a utility strike that deals light damage and reduces enemy movement speed by 65% and increases poison damage taken by 30% for 4 sec.'}],
  ['shadow',{id:'shadow_cloak',name:'Cloak of Shadows',icon:'🧥',x:16,y:92,max:1,req:['shadow_elusiveness'],unlockAbility:true,desc:'Unlocks Cloak of Shadows: a self defensive against caster pressure.'}],
  ['shadow',{id:'shadow_garrote',name:'Garrote',icon:'🩸',x:84,y:92,max:1,req:['shadow_elusiveness'],unlockAbility:true,desc:'Unlocks Garrote: a bleed-style pressure tool for sustained Rogue setups.'}],
  ['wind',{id:'wind_leg_sweep',name:'Leg Sweep',icon:'🦵',x:16,y:92,max:1,req:['wind_iron_body'],unlockAbility:true,desc:'Unlocks Leg Sweep: an area stun for coordinated kill attempts.'}],
  ['wind',{id:'wind_chi_wave',name:'Chi Wave',icon:'🟢',x:84,y:92,max:1,req:['wind_iron_body'],unlockAbility:true,desc:'Unlocks Chi Wave: a ranged utility spell for light pressure or emergency self-healing.'}]
 ].forEach(([c,n])=>add(c,n));
}
enhanceTalentTreeNodes();

function applyV217TalentText(){
 const update=(cls,id,changes)=>{const node=(TALENT_TREES[cls]||[]).find(x=>x.id===id);if(node)Object.assign(node,changes);};
 update('warrior','war_execute_strike',{name:'Stormbolt',icon:'🔮',desc:'Unlocks Stormbolt: a 22m violet missile that stuns for 3 sec on a 25 sec cooldown.'});
 update('wind','wind_chi_burst',{name:'Touch of Death',icon:'☠️',desc:'Unlocks Touch of Death: record your damaging-spell damage for 5 sec, then detonate 20% of the amount dealt.'});
 update('wind','cyclonetech',{name:'Death Touch Technique',icon:'☠️',desc:'Improves coordinated Touch of Death windows and rewards loading damage into the five-second mark.'});
 update('wind','wind_tigers_lust',{desc:"Unlocks Tiger's Lust: remove snares and roots, then gain 60% movement speed for 4 sec."});
}

function applyTalentReworksV127(){const each=(cls,fn)=>{(TALENT_TREES[cls]||[]).forEach(fn);};const remove=(cls,id)=>{TALENT_TREES[cls]=(TALENT_TREES[cls]||[]).filter(n=>n.id!==id);};const add=(cls,node)=>{if(TALENT_TREES[cls]&&!TALENT_TREES[cls].some(n=>n.id===node.id))TALENT_TREES[cls].push(node);};remove('flame','flame_inferno_wave');each('flame',n=>{if(n.id==='flame_meteor_spear'){n.name='Living Bomb';n.icon='💣';n.desc='Unlocks Living Bomb: a 6 sec dispellable fire DoT that explodes if not cleansed.';}if(n.id==='flame_molten_armor'){n.name='Fire Shield';n.icon='🛡️';n.desc='Unlocks Fire Shield: attackers who hit the shield take fire damage and a short burn.';}if(n.id==='flame_cauterize'){n.name='Cauterize';n.icon='❤️‍🔥';n.unlockAbility=false;n.desc='Passive cheat death. First lethal damage leaves you at 30% health, grants 50% speed, then burns out after 5 sec regardless of healing.';}});add('flame',{id:'flame_combustion',name:'Combustion',icon:'🔥',x:50,y:72,max:1,req:['flame_ashen_vitality'],unlockAbility:true,desc:'Offensive cooldown: ignite yourself, gain 30% extra crit chance and 15% faster casts for 8 sec.'});each('shadow',n=>{if(n.id==='shadow_sap'){n.name='Crimson Vial';n.icon='🧪';n.desc='Unlocks Crimson Vial: instant self-heal.';}if(n.id==='shadow_crimson_vial'){n.name='Evasion';n.icon='💨';n.desc='Unlocks Evasion: 50% dodge against melee for 8 sec.';}if(n.id==='shadow_shadowstep'){n.name='Vendetta';n.icon='🎯';n.desc='Unlocks Vendetta: mark a target for 8 sec, making rogue bleeds and poisons tick faster and making Viper Cut tick faster.';}if(n.id==='shadow_cloak'){n.name='Cloak of Shadows';n.desc='Remove and become immune to DoTs and non-physical spells for 5 sec; physical attacks still connect.';}if(n.id==='shadow_garrote'){n.name='Garrote';n.desc='Heavy bleed that also silences for 1.5 sec.';}});each('storm',n=>{if(n.id==='storm_mana_well'){n.name='Totem Mastery';n.icon='🪧';n.desc='Small totems grant 3% damage, healing, shield and proc chance.';}if(n.id==='storm_thunderstep'){n.name='Stormkeeper';n.icon='🔱';n.desc='1.5 sec cast granting three instant Lightning Bolts on a 0.25 sec GCD.';}if(n.id==='storm_grounding_aegis'){n.name='Frost Shock';n.icon='❄️';n.desc='Spammable 50% snare with tiny damage.';}if(n.id==='storm_chain_spark'){n.desc='Buffed chain lightning that arcs through nearby enemies for 100+ damage.';}});each('wind',n=>{if(n.id==='wind_leg_sweep'){n.name='Tigereye Brew';n.icon='🍺';n.unlockAbility=false;n.desc='Passive. Every 2 Zephyr Palms grant 2 stacks, up to 6. Consume 2/4/6 stacks for 10%/20%/30% damage and healing.';}if(n.id==='wind_tiger_rush'){n.name='Strike of the Windlord';n.icon='🌩️';n.desc='Heavy strike that resets Cloudstep Kick and increases its next damage by 15%.';}if(n.id==='wind_chi_wave'){n.name='Rushing Jade Wind';n.icon='🌀';n.unlockAbility=false;n.desc='Passive. During Fists of Fury, gain gusty wind ticks alongside the channel.';}});remove('wind','wind_paralysis');add('wind',{id:'wind_disabling_reach',name:'Disabling Reach',icon:'🪢',x:16,y:92,max:1,req:['wind_iron_body'],unlockAbility:true,desc:'60% movement snare from 8m for up to 4 sec.'});}applyTalentReworksV127();applyV217TalentText();
for(const node of TALENT_TREES.storm||[]){
 if(node.id==='storm_static_field'){node.name='Healing Stream Totem';node.icon='💧';node.desc='Summon a killable 280-health totem at your feet for 10 sec. It heals group members within 18m for 90 every 2 sec.';}
 if(node.id==='storm_chain_spark'){node.name='Healing Surge';node.icon='🔗';node.desc='Unlocks Healing Surge: a 0.75 sec cast that restores 340 health to yourself or an ally before gear, critical strikes and dampening.';}
 if(node.id==='storm_thunderstep')node.desc='1.5 sec cast granting three free instant Arc Sparks with +10% damage and no mini-GCD.';
}
for(const node of TALENT_TREES.flame||[])if(node.id==='flame_combustion')node.desc='Offensive cooldown: gain 80% critical strike chance and 15% faster casts for 8 sec.';
function classTalentState(cls){progression.talents=progression.talents&&typeof progression.talents==='object'?progression.talents:{};if(!progression.talents[cls])progression.talents[cls]={};return progression.talents[cls];}
function applyV221TalentText(){
 const update=(cls,id,changes)=>{const node=(TALENT_TREES[cls]||[]).find(x=>x.id===id);if(node)Object.assign(node,changes);};
 update('flame','flame_phoenix_guard',{name:'Alter Time',icon:'⏳',desc:'Unlocks Alter Time: save your current location and health, then return after 5 sec or by recasting. 1 min cooldown.'});
 update('warrior','war_disarm',{desc:'Unlocks Warbreaker: deal 115 damage, empower the next Mortal Swing by 30%, then unleash three measured Slicing Winds at 60% Mortal Swing damage each.'});
 update('storm','storm_mana_well',{name:'Totem Mastery',icon:'🪧',desc:'Place small totems granting 5% damage, healing, shield and proc chance. Flame Shock deals 10% extra damage while active. Costs 0 Mana.'});
 update('wind','wind_chi_burst',{name:'Touch of Death',icon:'☠️',desc:'Unlocks Touch of Death: record your damaging-spell damage for 5 sec, then detonate 30% of the amount dealt.'});
}
applyV221TalentText();
for(const node of TALENT_TREES.soul||[]){
 if(node.id==='soul_void_mend')Object.assign(node,{name:'Chaos Bolt',icon:'🟢',replaceAbility:'Unstable Affliction + Creeping Torment',desc:'Unlocks Chaos Bolt: replace Unstable Affliction with a 1.6 sec guaranteed-critical cast on a 10 sec cooldown, and transform Creeping Torment into the 1.35 sec Immolate cast. Essence Siphon ticks reduce Chaos Bolt cooldown by 3 sec.'});
 if(node.id==='soul_dark_pact')node.desc='Unlocks Dark Pact: shield yourself for 30% of your maximum health for 6 sec without gaining Soul Barrier interrupt immunity.';
}
function refreshTalentDescriptions(){
 const exact={
  emberfocus:'All Flame Duelist damage is increased by 3% per rank.',
  warlust:'All Warrior damage is increased by 3% per rank.',
  flame_meteor_spear:'Unlocks Living Bomb: apply a removable 6 sec fire effect that explodes for heavy area damage if it reaches the end of its duration.',
  flame_phoenix_guard:'Unlocks Alter Time: save your health and location for 5 sec, then return by pressing it again or when the effect expires. Its cooldown is 60 sec.',
  flame_cauterize:'Passive: the first lethal hit leaves you at 30% health and grants 50% movement speed. You are defeated 5 sec later regardless of healing.',
  flame_overheat:'Living Bomb, Fire Shield or Combustion empowers your next Cinder Bolt by 2% per rank for 10 sec.',
  flame_tempered_focus:'Beginning a cast while an enemy is within 8m reduces damage taken by 2% per rank for 2 sec.',
  grounded:'While casting, each hit taken has an 8% chance per rank to restore 2 mana.',
  storm_arc_battery:'When Storm Surge triggers, restore 1 additional mana per rank.',
  storm_aftershock:'A successful Wind Shear empowers your next direct-damage spell by 2% per rank for 10 sec.',
  storm_lava_burst:'Unlocks Volcanic Eruption: a 24m eruption for 353 damage plus two automatic Lava Bursts, around 473 total. Skybreaker Pulse charges one use.',
  storm_grounding_aegis:'Unlocks Frost Shock: deal 38 Frost damage and slow the target by 25% for up to 3 sec on root/snare diminishing returns. Its damage mark lasts 8 sec and increases your Arc Spark and Forked Current damage against that enemy by 15%.',
  storm_static_field:'Unlocks Healing Stream Totem: summon a killable 280-health totem for 10 sec that heals allies within 18m for 90 every 2 sec.',
  storm_chain_spark:'Unlocks Healing Surge: after a 0.75 sec cast, restore 340 health to yourself or an ally. Its cooldown begins only when the cast finishes successfully.',
  soul_curse_weaving:'Refreshing Soul Scar, Creeping Torment or Immolate empowers your next direct Shadow hit by 2% per rank for 10 sec.',
  soul_barrier_rites:'Soul Barrier and Dark Pact absorb 3% more damage per rank.',
  soul_void_mend:'Unlocks Chaos Bolt: replace Unstable Affliction with a 1.6 sec cast dealing 510 baseline Shadow damage on a 10 sec cooldown. Chaos Bolt always critically strikes, Critical Strike chance increases its damage, Creeping Torment becomes a 1.35 sec Immolate, and Essence Siphon ticks reduce Chaos Bolt cooldown by 3 sec.',
  soul_dark_pact:'Unlocks Dark Pact: absorb damage equal to 30% of your maximum health for 6 sec. It does not grant Soul Barrier interrupt immunity. Barrier Rites increases the shield.',
  barkskin:'Reduce the cooldown of Fae Retreat and Ironbark by 2 sec per rank.',
  sage_verdant_tempo:'Blooming Echo, Rejuvenate and other healing-over-time ticks heal for 3% more per rank.',
  sage_root_warden:'Reduce the cooldown of Fae Retreat, Lullaby Bloom and Nature’s Grasp by 2 sec per rank.',
  sage_natures_grasp:'Unlocks Nature’s Grasp: root an enemy for up to 5 sec on a 25 sec cooldown. Repeated roots have shorter durations.',
  sage_rejuvenating_gust:'Unlocks Nature Swiftness: for 8 sec, use Renewal Tide even while it is on cooldown or cast Lullaby Bloom instantly even while it is on cooldown. The chosen spell consumes the effect.',
  guardianlight:'Guardian Angel and other Paladin shields absorb 4% more damage per rank.',
  radiance:'Holy Shock, Divine Toll Holy Shocks and Light of Dawn heal for 4% more per rank.',
  pala_sacred_vow:'Blessing of Sacrifice lasts 0.25 sec longer per rank.',
  pala_radiant_shock:'Holy Shock gains 3% critical strike chance per rank.',
  pala_guardian_angel:'Unlocks Guardian Angel: summon a killable Val’kyr with 124 health for 6 sec. It follows the chosen ally and keeps them immune to damage while it remains alive.',
  pala_freedom:'Unlocks Blessing of Freedom: remove and prevent roots and movement slows for 5 sec while increasing the chosen ally’s movement speed by 30%.',
  garrote:'Garrote and Internal Bleeding deal 4% more damage per rank. Garrote applies a bleed and does not silence.',
  eviscerate:'All Shadowblade damage against targets below 35% health is increased by 5% per rank.',
  shadow_poisoncraft:'Viper Cut poison, Garrote and other Shadowblade bleeds deal 3% more damage per rank.',
  shadow_veil_training:'Smoke Veil, Evasion and Cloak of Shadows last 0.25 sec longer per rank.',
  tigerdash:'Cloudstep Kick and Tiger’s Lust recover 1 sec faster per rank.',
  cyclonetech:'Touch of Death and Whirling Dragon Punch deal 4% more damage per rank.',
  wind_nimble_brew:'Cloudstep Kick, Tiger’s Lust, Disabling Reach and Strike of the Windlord recover 1 sec faster per rank.',
  wind_temple_guard:'While Willow Guard or Touch of Karma is active, reduce damage taken by an additional 3% per rank.',
  wind_tiger_rush:'Unlocks Strike of the Windlord as your signature attack. Choosing it prevents learning Whirling Dragon Punch.',
  wind_whirling_dragon:'Unlocks Whirling Dragon Punch as your signature attack. It deals 252 area damage while Fists of Fury is on cooldown, 40% more than the former baseline version. Choosing it prevents learning Strike of the Windlord.',
  war_hold_the_line:'After Charge, reduce damage taken by 2% per rank for 3 sec.',
  soul_shadowfury:'Unlocks Shadowfury: choose a ground location; enemies in the 4.5m area take 42 Shadow damage and are stunned for 3 sec. Your next Pandemic Bloom deals 20% more damage.',
  soul_summon_infernal:'Unlocks Summon Infernal: choose a ground location within 22m. The landing deals 90 Shadow damage and stuns enemies in the 5m area for 2 sec. Enemies struck by the landing or its Immolation take 10% increased damage for 10 sec. The killable Infernal lasts 10 sec with 25% of your maximum health, chases the nearest enemy, deals 50 damage within 8m every 2 sec and restores 4 mana every second.',
  flame_combustion:'Unlocks Combustion: gain 80% critical strike chance and cast spells 15% faster for 8 sec.',
  shadow_shadowstep:'Unlocks Vendetta: mark an enemy for 10 sec, causing your Garrote, Internal Bleeding, poisons and bleeds to tick twice as fast. Its cooldown is 60 sec.',
  shadow_sap:'Unlocks Crimson Vial: restore 1.5% maximum health every second for 10 sec, for 15% total health. This healing ignores dampening.',
  shadow_crimson_vial:'Unlocks Evasion: gain a 70% chance to dodge incoming melee attacks for 8 sec.',
  shadow_gouge:'Unlocks Gouge: prevent a nearby enemy from moving or acting for 3 sec. Any damage can break the effect. Learning Gouge also increases all Shadowblade damage by 10%.',
  shadow_garrote:'Unlocks Garrote: apply a strong 8 sec bleed. Garrote does not silence and ticks twice as fast during Vendetta.'
 };
 Object.values(TALENT_TREES).flat().forEach(node=>{if(exact[node.id])node.desc=exact[node.id];node.desc=cleanAbilityText(node.desc||'');node.choiceDesc=cleanAbilityText(node.choiceDesc||'');});
}
refreshTalentDescriptions();
function refreshSpecialisationChoices(){
 const update=(cls,id,changes)=>{const node=(TALENT_TREES[cls]||[]).find(n=>n.id===id);if(node)Object.assign(node,changes);};
 const shared=(cls,ids,label,icon,choiceDesc)=>ids.forEach(id=>update(cls,id,{choiceLabel:label,choiceIcon:icon,choiceDesc}));
 shared('disc',['disc_archangel','disc_dark_archangel'],'Angelic Alignment','✦','Choose Archangel for stronger Atonement healing or Dark Archangel for stronger offensive pressure. Both choices unlock the named active ability.');
 shared('flame',['meteorimpact','counterheat'],'Flame Specialisation','☄️','Choose Meteor Impact for stronger Meteor Lance pressure or Counterheat for extra mana from successful Counterflare interrupts.');
 shared('warrior',['executioner','battlehardened'],'Warrior Doctrine','🪓','Choose Executioner for pressure against low-health enemies or Battle Hardened for damage reduction while you are low.');
 shared('storm',['lavacore','grounded'],'Stormwarden Specialisation','🔱','Choose Lava Core for stronger Storm burst or Grounded Casting for mana recovery while enemies pressure your casts.');
 shared('soul',['pandemic','souldrain'],'Soulweaver Specialisation','☠️','Choose Pandemic Spread for multi-target affliction pressure or Soul Drain for stronger single-target Shadow pressure and Essence Siphon.');
 shared('sage',['wildgrowth','barkskin'],'Lifesage Specialisation','🌸','Choose Wild Growth for stronger emergency healing on low-health allies or Barkskin Discipline for faster defensive cooldowns.');
 shared('pala',['guardianlight','radiance'],'Paladin Specialisation','🛡️','Choose Guardian Light for stronger shields or Radiance for stronger Holy Shock, Divine Toll and Light of Dawn healing.');
 shared('shadow',['garrote','eviscerate'],'Shadowblade Specialisation','☠️','Choose Garrote Setup for stronger Garrote and Internal Bleeding pressure or Eviscerate for stronger damage against enemies below 35% health.');
 shared('wind',['tigerdash','cyclonetech'],'Windwalker Specialisation','🌪️','Choose Flowing Steps for faster mobility or Finishing Technique for stronger Touch of Death and Whirling Dragon Punch.');
 update('wind','tigerdash',{name:'Flowing Steps',icon:'🦶',desc:'Cloudstep Kick and Tiger’s Lust cooldowns are reduced by 1 sec per rank.'});
 update('wind','cyclonetech',{name:'Finishing Technique',icon:'🐉',desc:'Touch of Death and Whirling Dragon Punch deal 4% more damage per rank.'});
}
refreshSpecialisationChoices();

// Specialisation choices gate the active spells that hang beneath them. Learning one
// side of a specialisation locks the actives attached to the other side, which is what
// makes the choice meaningful. The only exception is the Windwalker capstone row below,
// which is a "pick any two" pool reachable from either specialisation.

/* Windwalker tree.
   Layout matches the original live arrangement: a diamond down to Wind Path, the
   specialisation hub flanked by Nimble Brew and Temple Guard, then the capstone row.
   Whirling Dragon Punch is baseline again, so the capstone pool is Touch of Karma,
   Touch of Death and Strike of the Windlord: learn any two, in any combination, from
   either specialisation branch. */
{
 const windTree=TALENT_TREES.wind||[];
 const node=id=>windTree.find(n=>n.id===id);
 const place=(id,x,y)=>{const n=node(id);if(n)Object.assign(n,{x,y});};
 place('flowstate',50,8);
 place('longdash',32,25);
 place('focusfury',68,25);
 place('windpath',50,43);
 /* The two specialisation options render as one hub at their midpoint (x:50). */
 place('wind_nimble_brew',22,62);
 place('tigerdash',36,62);
 place('cyclonetech',64,62);
 place('wind_temple_guard',78,62);
 place('wind_tigereye_brew',50,72);
 place('wind_tigers_lust',50,83);
 place('wind_iron_body',50,93);
 place('wind_chi_wave',84,92);
 /* wind_leg_sweep was a dead second "Tigereye Brew": same name and text as the real
    node, granting nothing and read by no code. Disabling Reach inherits its slot so
    the arrow from Iron Body stays. */
 place('wind_disabling_reach',16,92);
 const capstoneText={
  wind_tiger_rush:'Unlocks Strike of the Windlord: a heavy strike that resets Cloudstep Kick and increases its next damage by 15%.',
  wind_karma:'Unlocks Touch of Karma: for 4 sec, each damaging hit you take deals 30% of the health damage back to its attacker and restores health equal to 50% of the damage you took.',
  wind_chi_burst:'Unlocks Touch of Death: mark an enemy for 5 sec while recording the damage your spells deal to it, then detonate for 30% of the recorded amount.'
 };
 [['wind_tiger_rush',36,82],['wind_karma',64,82],['wind_chi_burst',78,82]].forEach(([id,x,y])=>{
  const n=node(id);if(!n)return;
  delete n.choice;delete n.choiceLabel;delete n.choiceIcon;delete n.choiceDesc;
  Object.assign(n,{x,y,max:1,req:['tigerdash','cyclonetech'],unlockAbility:true,capstone:true,capstoneGroup:'wind_capstone',capstoneLimit:2,desc:`${capstoneText[id]} Windwalker capstone: you may learn any two of Touch of Karma, Touch of Death and Strike of the Windlord.`});
 });
 /* Whirling Dragon Punch is baseline, not a talent. */
 delete TALENT_UNLOCKED_ABILITIES.wind.wind_whirling_dragon;
 TALENT_TREES.wind=windTree.filter(n=>n.id!=='wind_whirling_dragon'&&n.id!=='wind_leg_sweep');
}

/* Shadowblade: the specialisation pick stays, but the four abilities beneath it are
   no longer decided by it. Each side is now its own either/or choice, so a Shadowblade
   picks one defensive (Evasion or Crimson Vial) and one pressure tool (Vendetta or
   Gouge) on top of the specialisation. */
{
 const tree=TALENT_TREES.shadow||[];
 const pair=(ids,group,label,icon,desc)=>ids.forEach(id=>{
  const node=tree.find(n=>n.id===id);if(!node)return;
  Object.assign(node,{req:['garrote','eviscerate'],choice:group,inlineChoice:true,choiceLabel:label,choiceIcon:icon,choiceDesc:desc});
 });
 pair(['shadow_crimson_vial','shadow_sap'],'shadow_defensive','Shadowblade Defensive',String.fromCodePoint(0x1F9EA),'Choose Evasion to dodge melee swings or Crimson Vial for an instant self-heal.');
 pair(['shadow_shadowstep','shadow_gouge'],'shadow_pressure','Shadowblade Pressure',String.fromCodePoint(0x1F3AF),'Choose Vendetta to make your bleeds and poisons tick faster or Gouge for a second incapacitate.');
}

/* Capstone pools: a set of nodes sharing a capstoneGroup from which only `capstoneLimit`
   may ever be learned, in any combination. Used by the Windwalker capstone row so that
   Touch of Karma / Touch of Death / Strike of the Windlord / Whirling Dragon Punch are
   four independent nodes of which you pick any two. */
function talentCapstoneBlocked(tree,rankOf,node){
 if(!node||!node.capstoneGroup||rankOf(node.id)>0)return false;
 const picked=(tree||[]).reduce((n,x)=>n+((x.capstoneGroup===node.capstoneGroup&&x.id!==node.id&&rankOf(x.id)>0)?1:0),0);
 return picked>=(node.capstoneLimit||2);
}
function pruneTalentCapstoneOverflow(tree,state){
 const groups={};let changed=false;
 (tree||[]).forEach(n=>{if(n.capstoneGroup&&Number(state[n.id]||0)>0)(groups[n.capstoneGroup]||(groups[n.capstoneGroup]=[])).push(n);});
 Object.values(groups).forEach(list=>{list.slice(list[0].capstoneLimit||2).forEach(n=>{delete state[n.id];changed=true;});});
 return changed;
}
function talentTree(cls){return TALENT_TREES[cls]||TALENT_TREES.flame;}
function talentRank(cls,id){return Number(classTalentState(cls)[id]||0);}
function unitTalentRank(unit,id){return Number(unit&&unit.netTalents?unit.netTalents[id]||0:talentRank(unit?.cls,id));}
function spentTalentPoints(cls){return Object.values(classTalentState(cls)).reduce((a,b)=>a+(Number(b)||0),0);}
function earnedTalentPoints(cls){const r=Math.max(classRating(cls,'1v1'),classRating(cls,'2v2'),classRating(cls,'3v3'));return Math.max(26,Math.min(48,26+Math.floor(Math.max(0,r-1600)/90)+Math.floor((progression.wins||0)/30)));}
function availableTalentPoints(cls){return Math.max(0,earnedTalentPoints(cls)-spentTalentPoints(cls));}
function talentNodeAvailable(cls,node){const state=classTalentState(cls);if((state[node.id]||0)>=node.max)return false;if(talentCapstoneBlocked(talentTree(cls),id=>Number(state[id]||0),node))return false;if(node.req&&node.req.length&&!node.req.some(id=>(state[id]||0)>0))return false;if(node.choice&&talentTree(cls).some(n=>n.choice===node.choice&&n.id!==node.id&&(state[n.id]||0)>0))return false;return availableTalentPoints(cls)>0;}


function windTigereyeTalentActive(u){return !!(u&&u.cls==='wind'&&progression?.talents?.wind?.wind_tigereye_brew);}
function windTigereyeStacks(u){return Math.max(0,Math.min(6,Number(u?.tigereyeStacks||0)));}
function windTigereyeBuffMult(u){
 const buff=u?.has?.('tigereyeBrew');
 return buff?1+(Number(buff.power||0)) : 1;
}
function grantTigereyeStacks(u,amount=2){
 if(!windTigereyeTalentActive(u))return;
 u.tigereyeStacks=Math.max(0,Math.min(6,(u.tigereyeStacks||0)+amount));
 if(window.game&&game.float){game.float(u,`Tigereye Brew ${u.tigereyeStacks}/6`,'buff');game.renderActions?.();}
}

function classTalentDamageMult(cls,c=null,t=null,label=''){
 let m=1;
 const r=id=>c?unitTalentRank(c,id):talentRank(cls,id);
 try{
  m+=talentTree(cls).reduce((x,n)=>x+(r(n.id)*(n.effects?.damagePct||0))/100,0);
 }catch(err){
  console.warn('Talent damage fallback',cls,err);
  m=1;
 }
 if(cls==='flame'&&/Meteor Lance|Ember Lance/.test(label))m+=r('meteorimpact')*.04;
 if(cls==='warrior'&&/Mortal Swing/.test(label)&&t&&t.hp/t.maxHp<.35)m+=r('executioner')*.05;
 if(cls==='warrior'&&/Rend|Gushing Wound/.test(label))m+=r('deepwounds')*.05;
 if(cls==='storm'&&/Volcanic|Forked|Lava|Tempest/.test(label))m+=r('lavacore')*.04;
 if(cls==='wind'&&/Fists/.test(label))m+=r('focusfury')*.04;
 if(cls==='wind'&&/Touch of Death|Whirling Dragon/.test(label))m+=r('cyclonetech')*.04;
 if(cls==='soul'&&/Essence Siphon|Pandemic Bloom|Soul Scar|Creeping Torment|Unstable Affliction/.test(label))m+=r('souldrain')*.04;
 if(cls==='soul'&&c?.game?.units?.filter(u=>u.team!==c.team&&u.alive&&['soulScar','agony','unstableAffliction'].some(type=>u.has?.(type))).length>=2)m+=r('pandemic')*.04;
 if(cls==='shadow'&&/Poison|Bleed|Garrote|Viper Cut|Internal Bleeding/.test(label))m+=r('shadow_poisoncraft')*.03;
 if(cls==='shadow'&&/Garrote|Internal Bleeding/.test(label))m+=r('garrote')*.04;
 if(cls==='shadow'&&r('shadow_gouge')>0)m+=.10;
 if(cls==='shadow'&&t&&t.hp/t.maxHp<.35)m+=r('eviscerate')*.05;
 if(c?.has?.('totemMastery')){
  m*=1.05/1.03;
  if(/Flame Shock/i.test(label))m*=1.10;
 }
 if(cls==='wind'&&c)m*=windTigereyeBuffMult(c);
 return Number.isFinite(m)&&m>0?m:1;
}
function classTalentHealingMult(cls,c=null){let m=1+talentTree(cls).reduce((x,n)=>x+(talentRank(cls,n.id)*(n.effects?.healingPct||0))/100,0);if(cls==='sage')m*=.90;if(cls==='wind'&&c)m*=windTigereyeBuffMult(c);if(c?.has?.('totemMastery'))m*=1.05/1.03;return m;}function classTalentStaminaMult(cls){return 1+talentTree(cls).reduce((m,n)=>m+(talentRank(cls,n.id)*(n.effects?.staminaPct||0))/100,0);}window.TALENT_TREES=TALENT_TREES;

function defaultProgression(){
 const ratings={'1v1':{},'2v2':{},'3v3':{}},equipped={};GEAR_CLASSES.forEach(c=>{ratings['1v1'][c]=1600;ratings['2v2'][c]=1600;ratings['3v3'][c]=1600;equipped[c]={};});
 return {shards:900,ratings,equipped,inventory:[],matches:0,wins:0,duelMatches:0,duelWins:0,tournaments:0,tournamentCupRewarded:{},tournamentCupWins:{},achievements:{},achievementClasses:{},currentTitle:'',mounts:baselineMountIds(),activeMount:'skyhoof',mountSkins:{aethergladiatorwyrm:['default']},activeMountSkins:{aethergladiatorwyrm:'default'},talents:{},settings:{hideCombatText:false,hideLiveDetails:false,stackingNameplates:true,showTargetOfTarget:true,hudScale:1,raidFrameStyle:'detailed',showFPS:false,performanceMode:true,instantCamera:true,hudLayout:{}}};
}
const ACHIEVEMENTS=[
 {id:'rating1700',type:'rating',threshold:1700,icon:'🜂',name:'Gate Aspirant',title:'Gate Aspirant',rewardShards:750,desc:'Reach 1700 rating in any bracket on any class.'},
 {id:'rating1800',type:'rating',threshold:1800,icon:'⚔️',name:'Arena Challenger',title:'Arena Challenger',rewardShards:1200,desc:'Reach 1800 rating in any bracket on any class.'},
 {id:'rating2000',type:'rating',threshold:2000,icon:'👑',name:'Mythical Elite',title:'Mythical Elite',rewardShards:10000,rewardMount:'infernalwarstrider',desc:'Reach 2000 rating, earn the large alt-catchup shard reward and unlock the Infernal Warstrider mount.'},
 {id:'rating2200',type:'rating',threshold:2200,icon:'💀',name:'Aether Legend',title:'Aether Legend',rewardShards:6000,rewardMount:'aetherdeathcharger',desc:'Reach 2200 rating to earn the Aether Legend title, bonus Valor Shards and the Aether Deathcharger mount.'},
 {id:'rating2400',type:'rating',threshold:2400,icon:'🐲',name:'Aether Gladiator',title:'Aether Gladiator',rewardShards:12000,rewardMount:'aethergladiatorwyrm',desc:'Reach 2400 rating to earn the Aether Gladiator title, a major Valor reward and the Aether Gladiator Wyrm.'},
 {id:'rating2700_2v2',type:'bracketRating',mode:'2v2',threshold:2700,icon:'🐲',name:'Stormforged Gladiator',title:'Stormforged Gladiator',rewardShards:16000,rewardMount:'aethergladiatorwyrm',rewardMountSkin:'silverstorm',desc:'Reach 2700 rating in 2v2. Unlocks the Silverstorm colour scheme for the Aether Gladiator Wyrm.'},
{id:'rating2700_3v3',type:'bracketRating',mode:'3v3',threshold:2700,icon:'🐉',name:'Stormforged GladiatorI',title:'Stormforged GladiatorI',rewardShards:16000,rewardMount:'aethergladiatorwyrm',rewardMountSkin:'emeraldrift',desc:'Reach 2700 rating in 3v3. Unlocks the Emerald Rift colour scheme for the Aether Gladiator Wyrm.'},
{id:'rating3000_2v2',type:'bracketRating',mode:'2v2',threshold:3000,icon:'🌌',name:'Cosmic Duelist',title:'Cosmic Duelist',rewardShards:24000,rewardMount:'aethergladiatorwyrm',rewardMountSkin:'crimsonvoid',desc:'Reach 3000 rating in 2v2. Unlocks the Crimson Void colour scheme for the Aether Gladiator Wyrm.'},
{id:'rating3000_3v3',type:'bracketRating',mode:'3v3',threshold:3000,icon:'👑',name:'Cosmic Gladiator',title:'Cosmic Gladiator',rewardShards:30000,rewardMount:'aethergladiatorwyrm',rewardMountSkin:'goldenascendant',desc:'Reach 3000 rating in 3v3. Unlocks the Golden Ascendant colour scheme for the Aether Gladiator Wyrm.'},

 {id:'tournament_champion',type:'tournament',threshold:1,icon:'🏟️',name:'Aether Cup Champion',title:'Aether Cup Champion',rewardShards:22000,rewardMount:'chronocrown_protodrake',desc:'Win the Aether Cup on each class. Every first class clear grants 22,000 Valor Shards, title eligibility for that class and its Chronocrown Proto-Drake colour.'},  {id:'wins10',type:'wins',threshold:10,icon:'🔥',name:'First Bloodline',title:'Bloodline Breaker',rewardShards:350,desc:'Win 10 arena rounds.'},
 {id:'wins25',type:'wins',threshold:25,icon:'🏹',name:'Skirmish Veteran',title:'Skirmish Veteran',rewardShards:600,desc:'Win 25 arena rounds.'},
 {id:'wins50',type:'wins',threshold:50,icon:'🛡️',name:'Pillar Dancer',title:'Pillar Dancer',rewardShards:1100,desc:'Win 50 arena rounds and prove your positioning belongs in rated play.'},
 {id:'wins100',type:'wins',threshold:100,icon:'🏆',name:'Arena Warmaster',title:'Arena Warmaster',rewardShards:1800,desc:'Win 100 arena rounds.'},

 {id:'duel_wins1',type:'duelWins',threshold:1,icon:'⚔️',name:'First Blood',title:'First Blood',rewardShards:400,desc:'Win your first 1v1 duel. No partner, no healer, no excuses.'},
 {id:'duel_wins10',type:'duelWins',threshold:10,icon:'🗡️',name:'Duelist',title:'Duelist',rewardShards:900,desc:'Win 10 duels in the 1v1 bracket.'},
 {id:'duel_wins25',type:'duelWins',threshold:25,icon:'🩸',name:'Bloodsworn',title:'Bloodsworn',rewardShards:1800,desc:'Win 25 duels in the 1v1 bracket.'},
 {id:'duel_wins50',type:'duelWins',threshold:50,icon:'🏴',name:'Solo Artist',title:'Solo Artist',rewardShards:3200,desc:'Win 50 duels and prove you carry yourself.'},
 {id:'duel_wins100',type:'duelWins',threshold:100,icon:'👑',name:'Unchallenged',title:'Unchallenged',rewardShards:6500,desc:'Win 100 duels in the 1v1 bracket.'},
 {id:'duel_wins250',type:'duelWins',threshold:250,icon:'☠️',name:'Arena Nemesis',title:'Arena Nemesis',rewardShards:14000,desc:'Win 250 duels. The bracket knows your name.'},
 {id:'rating1800_1v1',type:'bracketRating',mode:'1v1',threshold:1800,icon:'🥉',name:'Bronze Duelist',title:'Bronze Duelist',rewardShards:1500,rewardMount:'aethergladiatorwyrm',rewardMountSkin:'duelistbronze',desc:'Reach 1800 rating in 1v1. Unlocks the Bronze Duelist colour scheme for the Aether Gladiator Wyrm.'},
 {id:'rating2100_1v1',type:'bracketRating',mode:'1v1',threshold:2100,icon:'🥈',name:'Solo Ascendant',title:'Solo Ascendant',rewardShards:5000,rewardMount:'aethergladiatorwyrm',rewardMountSkin:'soloascendant',desc:'Reach 2100 rating in 1v1. Unlocks the Solo Ascendant colour scheme.'},
 {id:'rating2400_1v1',type:'bracketRating',mode:'1v1',threshold:2400,icon:'🐺',name:'Lone Wolf',title:'Lone Wolf',rewardShards:11000,rewardMount:'aethergladiatorwyrm',rewardMountSkin:'lonewolf',desc:'Reach 2400 rating in 1v1. Unlocks the Lone Wolf colour scheme.'},
 {id:'rating2700_1v1',type:'bracketRating',mode:'1v1',threshold:2700,icon:'🔮',name:'Duelist Gladiator',title:'Duelist Gladiator',rewardShards:16000,rewardMount:'aethergladiatorwyrm',rewardMountSkin:'duelistvoid',desc:'Reach 2700 rating in 1v1. Unlocks the Duelist Void colour scheme.'},
 {id:'rating3000_1v1',type:'bracketRating',mode:'1v1',threshold:3000,icon:'🌟',name:'Monarch of the Sands',title:'Monarch of the Sands',rewardShards:32000,rewardMount:'aethergladiatorwyrm',rewardMountSkin:'monarchsolus',desc:'Reach 3000 rating in 1v1 — the hardest solo climb in the game. Unlocks the Monarch Solus colour scheme.'},
 {id:'wins250',type:'wins',threshold:250,icon:'⚜️',name:'Seasoned Duelist',title:'Seasoned Duelist',rewardShards:4200,desc:'Win 250 arena rounds across your account.'}
];
function unlockedAchievementCount(){return Object.keys(progression.achievements||{}).length;}
function achievementRewardTotal(){return Object.values(progression.achievements||{}).reduce((sum,a)=>sum+(a.rewardShards||0),0);}
function unlockedAchievementDefinitions(){return ACHIEVEMENTS.filter(a=>progression.achievements?.[a.id]);}
function currentTitleClass(){return document.querySelector('#classSelect')?.value||window.game?.player?.cls||'flame';}
function achievementEligibleForClass(def,cls=currentTitleClass()){
 if(!def?.title)return false;
 if(def.type==='wins')return !!progression.achievements?.[def.id];
 if(def.type==='bracketRating')return classRating(cls,def.mode||'2v2')>=def.threshold;
 if(def.type==='rating')return Math.max(classRating(cls,'1v1'),classRating(cls,'2v2'),classRating(cls,'3v3'))>=def.threshold;
 if(def.type==='duelWins')return !!progression.achievements?.[def.id];
 if(def.type==='tournament')return !!progression.tournamentCupWins?.[cls];
 return !!progression.achievements?.[def.id];
}
function achievementClassList(def){return GEAR_CLASSES.filter(cls=>achievementEligibleForClass(def,cls));}
function activeAchievementTitle(cls=currentTitleClass()){const unlocked=unlockedAchievementDefinitions().filter(a=>a.title&&achievementEligibleForClass(a,cls));if(!unlocked.length)return 'Unproven';return unlocked.sort((a,b)=>(a.threshold||0)-(b.threshold||0))[unlocked.length-1].title;}
function availableAchievementTitles(cls=currentTitleClass()){const titles=unlockedAchievementDefinitions().filter(a=>a.title&&achievementEligibleForClass(a,cls)).map(a=>a.title);return Array.from(new Set(titles));}
function equippedAchievementTitle(cls=currentTitleClass()){const options=availableAchievementTitles(cls);if(progression.currentTitle==='__none__')return '';if(progression.currentTitle&&options.includes(progression.currentTitle))return progression.currentTitle;return options[options.length-1]||'';}
function playerTitleLabel(cls=currentTitleClass()){return equippedAchievementTitle(cls)||'Unproven';}
function achievementProgress(def){const current=def.type==='duelWins'?(progression.duelWins||0):def.type==='rating'?highestArenaRating():def.type==='bracketRating'?Math.max(...GEAR_CLASSES.map(c=>classRating(c,def.mode||'2v2'))):def.type==='tournament'?GEAR_CLASSES.filter(c=>progression.tournamentCupWins?.[c]).length:progression.wins;const total=def.type==='tournament'?GEAR_CLASSES.length:(def.threshold||1);return {current,total,pct:Math.max(0,Math.min(1,current/total))};}
function evaluateAchievements(){const unlocked=[];const highest=highestArenaRating();progression.achievementClasses=progression.achievementClasses||{};ACHIEVEMENTS.forEach(def=>{let eligibleClasses=def.type==='bracketRating'?GEAR_CLASSES.filter(c=>classRating(c,def.mode||'2v2')>=def.threshold):def.type==='rating'?GEAR_CLASSES.filter(c=>Math.max(classRating(c,'1v1'),classRating(c,'2v2'),classRating(c,'3v3'))>=def.threshold):def.type==='tournament'?GEAR_CLASSES.filter(c=>progression.tournamentCupWins?.[c]):[];if(def.type==='duelWins'&&(progression.duelWins||0)>=def.threshold)eligibleClasses=GEAR_CLASSES.slice();
 if(def.title&&eligibleClasses.length){const list=progression.achievementClasses[def.id]||(progression.achievementClasses[def.id]=[]);eligibleClasses.forEach(c=>{if(!list.includes(c))list.push(c);});}if(progression.achievements?.[def.id])return;const met=def.type==='rating'?highest>=def.threshold:def.type==='bracketRating'?eligibleClasses.length>0:def.type==='tournament'?eligibleClasses.length>0:def.type==='wins'?progression.wins>=def.threshold:def.type==='duelWins'?(progression.duelWins||0)>=def.threshold:false;if(!met)return;progression.achievements[def.id]={unlockedAt:Date.now(),rewardShards:def.type==='tournament'?0:(def.rewardShards||0),title:def.title||'',rewardMount:def.rewardMount||'',name:def.name};if(def.rewardShards&&def.type!=='tournament')progression.shards+=def.rewardShards;if(def.rewardMount&&!progression.mounts.includes(def.rewardMount))progression.mounts.push(def.rewardMount);if(def.rewardMountSkin){progression.mountSkins=progression.mountSkins||{};(progression.mountSkins[def.rewardMount]||(progression.mountSkins[def.rewardMount]=[]));if(!progression.mountSkins[def.rewardMount].includes(def.rewardMountSkin))progression.mountSkins[def.rewardMount].push(def.rewardMountSkin);}if(def.title&&!progression.currentTitle)progression.currentTitle=def.title;unlocked.push(def);});return unlocked;}

function bracketKey(mode){return mode==='3v3'?'3v3':mode==='1v1'?'1v1':'2v2';}
function loadProgression(){
 let p;try{p=JSON.parse(localStorage.getItem('aetherProgression')||'null');}catch(e){p=null;}
 if(!p)p=defaultProgression();
 p.shards=Number.isFinite(p.shards)?p.shards:900;p.inventory=Array.isArray(p.inventory)?p.inventory:[];p.matches=p.matches||0;p.wins=p.wins||0;p.duelMatches=p.duelMatches||0;p.duelWins=p.duelWins||0;p.tournaments=p.tournaments||0;p.tournamentCupWins=p.tournamentCupWins&&typeof p.tournamentCupWins==='object'?p.tournamentCupWins:{};p.tournamentCupRewarded=p.tournamentCupRewarded&&typeof p.tournamentCupRewarded==='object'?p.tournamentCupRewarded:{};p.equipped=p.equipped||{};p.achievements=p.achievements&&typeof p.achievements==='object'?p.achievements:{};p.achievementClasses=p.achievementClasses&&typeof p.achievementClasses==='object'?p.achievementClasses:{};p.currentTitle=typeof p.currentTitle==='string'?p.currentTitle:'';p.talents=p.talents&&typeof p.talents==='object'?p.talents:{};p.settings=p.settings&&typeof p.settings==='object'?p.settings:{hideCombatText:false,hideLiveDetails:false,stackingNameplates:true,showTargetOfTarget:true,hudScale:1,raidFrameStyle:'detailed',showFPS:false,performanceMode:true,instantCamera:true,hudLayout:{}};p.mountSkins=p.mountSkins&&typeof p.mountSkins==='object'?p.mountSkins:{};p.activeMountSkins=p.activeMountSkins&&typeof p.activeMountSkins==='object'?p.activeMountSkins:{};p.mountSkins.aethergladiatorwyrm=Array.isArray(p.mountSkins.aethergladiatorwyrm)?p.mountSkins.aethergladiatorwyrm:['default'];if(!p.mountSkins.aethergladiatorwyrm.includes('default'))p.mountSkins.aethergladiatorwyrm.unshift('default');p.activeMountSkins.aethergladiatorwyrm=p.mountSkins.aethergladiatorwyrm.includes(p.activeMountSkins.aethergladiatorwyrm)?p.activeMountSkins.aethergladiatorwyrm:'default';if(typeof p.settings.hideCombatText!=='boolean')p.settings.hideCombatText=false;if(typeof p.settings.hideLiveDetails!=='boolean')p.settings.hideLiveDetails=false;if(typeof p.settings.stackingNameplates!=='boolean')p.settings.stackingNameplates=true;if(typeof p.settings.showTargetOfTarget!=='boolean')p.settings.showTargetOfTarget=true;if(!Number.isFinite(Number(p.settings.hudScale)))p.settings.hudScale=1;p.settings.hudScale=clamp(Number(p.settings.hudScale),.7,1.4);if(!['detailed','class'].includes(p.settings.raidFrameStyle))p.settings.raidFrameStyle='detailed';if(typeof p.settings.showFPS!=='boolean')p.settings.showFPS=false;if(typeof p.settings.performanceMode!=='boolean')p.settings.performanceMode=true;if(typeof p.settings.instantCamera!=='boolean')p.settings.instantCamera=true;if(!p.settings.hudLayout||typeof p.settings.hudLayout!=='object'||Array.isArray(p.settings.hudLayout))p.settings.hudLayout={};p=unlockEligibleMounts(p);
  const savedHighestRating=(()=>{
   const rs=p.ratings||{};
   const vals=[];
   if(rs['2v2'])GEAR_CLASSES.forEach(c=>vals.push(Number(rs['2v2'][c])||1600));
   if(rs['3v3'])GEAR_CLASSES.forEach(c=>vals.push(Number(rs['3v3'][c])||1600));
   if(Number.isFinite(rs.flame))GEAR_CLASSES.forEach(c=>vals.push(Number(rs[c])||1600));
   return vals.length?Math.max(...vals):1600;
  })();
  if(p.achievements?.rating2200&&p.achievements.rating2200.name==='Aether Gladiator'){p.achievements.rating2200.name='Aether Legend';p.achievements.rating2200.title='Aether Legend';p.achievements.rating2200.rewardMount='aetherdeathcharger';}
  if(p.currentTitle==='Aether Gladiator'&&savedHighestRating<2400)p.currentTitle='Aether Legend';
 const oldRatings=p.ratings&&Number.isFinite(p.ratings.flame)?p.ratings:null;
 if(!p.ratings||!p.ratings['2v2']||!p.ratings['3v3']){const source=oldRatings||{};p.ratings={'1v1':{},'2v2':{},'3v3':{}};GEAR_CLASSES.forEach(c=>{const start=Number.isFinite(source[c])?source[c]:1600;p.ratings['1v1'][c]=start;p.ratings['2v2'][c]=start;p.ratings['3v3'][c]=start;});}
 if(!p.ratings['1v1'])p.ratings['1v1']={};
 p.inventory=p.inventory.map(item=>{
  const shadowmoon=item?.legendaryId==='shadowmoon'||(item?.classKey==='warrior'&&item?.slot==='Weapon'&&Number(item?.ilvl)===1000&&item?.source==='Shadowmoon Quartermaster');
  if(shadowmoon)return {...item,legendaryId:'shadowmoon',rarity:'legendary',name:'Shadowmoon',flavour:'A prestigious runebound axe. Its spiked crescent edges drink the echoes left behind by every melee strike.',effect:shadowmoonEffectText()};
  return {...item,rarity:item.rarity||rarityForIlvl(item.ilvl),name:gearName(item.classKey,item.slot,item.ilvl),flavour:item.flavour||gearFlavour(item.classKey)};
 });
 GEAR_CLASSES.forEach(c=>{if(!Number.isFinite(p.ratings['1v1'][c]))p.ratings['1v1'][c]=1600;if(!Number.isFinite(p.ratings['2v2'][c]))p.ratings['2v2'][c]=1600;if(!Number.isFinite(p.ratings['3v3'][c]))p.ratings['3v3'][c]=1600;if(!p.equipped[c])p.equipped[c]={};});
 const cupSkins=p.mountSkins?.chronocrown_protodrake||[];
 GEAR_CLASSES.forEach(c=>{if(cupSkins.includes(chronocrownSkinIdForClass(c)))p.tournamentCupWins[c]=true;});
 const cupClasses=GEAR_CLASSES.filter(c=>p.tournamentCupWins[c]);
 if(cupClasses.length){
  if(p.achievements.tournament_champion&&!Object.keys(p.tournamentCupRewarded).length)p.tournamentCupRewarded[cupClasses[0]]=true;
  let migratedRewards=0;cupClasses.forEach(c=>{if(!p.tournamentCupRewarded[c]){p.tournamentCupRewarded[c]=true;p.shards+=22000;migratedRewards+=22000;}});
  p.achievements.tournament_champion=p.achievements.tournament_champion||{unlockedAt:Date.now(),rewardShards:0,title:'Aether Cup Champion',rewardMount:'chronocrown_protodrake',name:'Aether Cup Champion'};
  p.achievements.tournament_champion.rewardShards=Number(p.achievements.tournament_champion.rewardShards||0)+migratedRewards;
  p.achievementClasses.tournament_champion=cupClasses;
  if(!p.mounts.includes('chronocrown_protodrake'))p.mounts.push('chronocrown_protodrake');
 }
 return p;
}
let progression=loadProgression();window.progression=progression;
function classRating(cls,mode='2v2'){return progression.ratings[bracketKey(mode)]?.[cls]||1600;}
function addClassRating(cls,mode,amount){const key=bracketKey(mode);progression.ratings[key][cls]=classRating(cls,key)+amount;return progression.ratings[key][cls];}
function saveProgression(){localStorage.setItem('aetherProgression',JSON.stringify(progression));window.progression=progression;}
function highestArenaRating(){return Math.max(...['1v1','2v2','3v3'].flatMap(mode=>GEAR_CLASSES.map(c=>classRating(c,mode))));}
function ratingTierMeta(r){if(r>=2400)return {name:'Aether Gladiator',icon:'🐲',css:'#dcb7ff'};if(r>=2200)return {name:'Aether Legend',icon:'💀',css:'#f5d27a'};if(r>=2000)return {name:'Mythical Elite',icon:'🏅',css:'#ffaf68'};if(r>=1800)return {name:'Challenger',icon:'⚔️',css:'#b388ff'};if(r>=1700)return {name:'Combatant',icon:'🛡️',css:'#7dc5ff'};return {name:'Unranked',icon:'✦',css:'#9db2c7'};}
function unlockedItemLevel(){  const steps=Math.max(0,Math.floor((highestArenaRating()-1600)/50));  return Math.min(990,910+steps*5); }
function gearUpgradeStep(ilvl){return ilvl<950?Math.min(950,ilvl+5):Math.min(990,Math.ceil((ilvl+1)/10)*10);}
function gearUpgradeCost(item){const next=gearUpgradeStep(item.ilvl);return Math.max(0,260+(next-950)*18);}
function canUpgradeGear(item){return !!(item&&item.ilvl>=950&&item.ilvl<990&&gearUpgradeStep(item.ilvl)<=unlockedItemLevel());}
function gearPrice(ilvl){return 145+(ilvl-910)*7+(ilvl>950?(ilvl-950)*12:0);}
function gearRecraftCost(item){const base=Math.max(1,Number(item?.price)||gearPrice(Number(item?.ilvl)||910));return Math.max(25,Math.round(base*GEAR_RECRAFT_RATE/5)*5);}
function blankStats(){return {Stamina:0,Intellect:0,Agility:0,Strength:0,Power:0,Restoration:0,Vitality:0,Mana:0,Versatility:0,'Critical Strike':0};}
function itemStatValues(item){
 const stats=blankStats(),mainStat=CLASS_PRIMARY[item.classKey]||'Strength';
 // Core attributes use a steeper high-end curve than build stats. Entry gear stays
 // close to its current pacing, while 990 and prestigious 1000 gear gain a clearly
 // stronger Stamina/primary identity instead of feeling like a tiny linear step.
 const ilvl=Number(item.ilvl||910),progress=clamp((ilvl-910)/90,0,1),coreCurve=Math.pow(progress,1.65),styleCurve=Math.pow(progress,1.55),legendary=ilvl>=1000;
 const stamina=Math.round(6+58*coreCurve+(legendary?8:0)),primary=Math.round(5+55*coreCurve+(legendary?7:0)),styleValue=Math.round(5+75*styleCurve);
 stats.Stamina+=stamina;stats[mainStat]+=primary;
 stats[item.statA]=(stats[item.statA]||0)+styleValue;stats[item.statB]=(stats[item.statB]||0)+styleValue;
 return stats;
}
function gearName(cls,slot,ilvl){
 if(slot==='Weapon'){
  if(ilvl>=990)return `Aetherforged ${LEGENDARY_WEAPONS[cls]||(`${GEAR_THEMES[cls]} Weapon`)}`;if(ilvl>=980)return `Celestial ${LEGENDARY_WEAPONS[cls]||(`${GEAR_THEMES[cls]} Weapon`)}`;if(ilvl>=970)return `Primal ${LEGENDARY_WEAPONS[cls]||(`${GEAR_THEMES[cls]} Weapon`)}`;if(ilvl>=960)return `Ascended ${LEGENDARY_WEAPONS[cls]||(`${GEAR_THEMES[cls]} Weapon`)}`;if(ilvl>=950)return LEGENDARY_WEAPONS[cls]||`${GEAR_THEMES[cls]} Legendary Weapon`;
  if(ilvl>=935)return `Elite ${ELITE_WEAPON_TYPES[cls]||(`${GEAR_THEMES[cls]} Weapon`)}`;
 }
 const tier=ilvl>=990?'Aetherforged ':ilvl>=980?'Celestial ':ilvl>=970?'Primal ':ilvl>=960?'Ascended ':ilvl>=950?'Legendary ':ilvl>=940?'Elite ':ilvl>=925?'Rival ':'';
 return `${tier}${GEAR_THEMES[cls]} ${SLOT_NAMES[slot]}`;
}
function gearFlavour(cls){
 return {
  flame:'Threads still smoulder after every cast.',shadow:'Woven to vanish before the finishing strike.',
  storm:'A storm growls faintly beneath its surface.',wind:'Balanced for relentless arena footwork.',
  soul:'Every seam whispers with stolen breath.',sage:'Leaves unfurl when allies fall low.',
  pala:'Forged beneath the light of an unbroken oath.',disc:'White-gold runes brighten whenever Atonement converts damage into healing.',
  warrior:'Tempered to hold its edge through every Warbreaker window.'
 }[cls];
}
function createGearItem(cls,slot,ilvl,statA,statB,source='Shop'){
 return {id:`gear_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,classKey:cls,slot,ilvl,statA,statB,source,name:gearName(cls,slot,ilvl),price:gearPrice(ilvl),flavour:gearFlavour(cls),rarity:rarityForIlvl(ilvl)};
}
function shadowmoonEffectText(){
 const fragmentDamage=(SHADOWMOON_FRAGMENT_STRENGTH*SHADOWMOON_STRENGTH_DAMAGE_PER_POINT*100).toFixed(1),baneDamage=(SHADOWMOON_CHAOS_STRENGTH*SHADOWMOON_STRENGTH_DAMAGE_PER_POINT*100).toFixed(0);
 return `Your melee attacks, including Bladestorm hits, have a ${Math.round(SHADOWMOON_PROC_CHANCE*100)}% chance to drain a Soul Fragment, granting ${SHADOWMOON_FRAGMENT_STRENGTH} Strength (+${fragmentDamage}% damage) per fragment. At 10 fragments, unleash Chaos Bane for ${SHADOWMOON_CHAOS_DAMAGE} Shadow damage split between enemies within 15 yards and gain ${SHADOWMOON_CHAOS_STRENGTH} Strength (+${baneDamage}% damage) for 10 sec.`;
}
function createShadowmoonItem(statA,statB){
 const item=createGearItem('warrior','Weapon',1000,statA,statB,'Shadowmoon Quartermaster');
 return {...item,name:'Shadowmoon',legendaryId:'shadowmoon',rarity:'legendary',price:SHADOWMOON_COST,
  flavour:'A prestigious runebound axe. Its spiked crescent edges drink the echoes left behind by every melee strike.',
  effect:shadowmoonEffectText()};
}

class Arena {
 constructor(scene){
  this.scene=scene;
  this.root=new THREE.Group();
  this.scene.add(this.root);
  this.theme='runestone';
  this.displayName='Twilight Runestone Court';
  this.pillars=[];
  this.colliders=[];
  this.setTheme('random');
 }
 clear(){
  while(this.root.children.length) this.root.remove(this.root.children[0]);
 }
 setTheme(theme='random'){
  const pick = theme==='random' ? (Math.random()<0.5?'runestone':'serpent') : theme;
  this.theme=pick;
  this.displayName = pick==='serpent' ? 'Serpent Gate Ruins' : pick==='training' ? 'Sanctum Training Grounds' : 'Twilight Runestone Court';
  if(pick==='training'){
   this.pillars=[];
   this.colliders=[];
  }else if(pick==='serpent'){
   this.pillars=[
    {x:-18.0,z:-10.7,r:1.72},{x:18.0,z:-10.7,r:1.72},
    {x:-18.0,z:10.7,r:1.72},{x:18.0,z:10.7,r:1.72}
   ];
   // Gate, statues and braziers now sit behind the playable boundary rather
   // than adding overlapping combat colliders that could trap bot movement.
   this.colliders=[];
  }else{
   this.pillars=[
    {x:-17.0,z:-10.2,r:1.76},{x:17.0,z:-10.2,r:1.76},
    {x:-17.0,z:10.2,r:1.76},{x:17.0,z:10.2,r:1.76}
   ];
   this.colliders=[];
  }
  this.build();
  return this.theme;
 }
 build(){
  this.clear();
  const group=this.root;
  if(this.theme==='training'){
   const floor=new THREE.Mesh(new THREE.CircleGeometry(40,104),new THREE.MeshStandardMaterial({color:0x171d22,roughness:.95,metalness:.03}));
   floor.rotation.x=-Math.PI/2; floor.position.y=-.55; group.add(floor);
   const inner=new THREE.Mesh(new THREE.CircleGeometry(9.5,64),new THREE.MeshStandardMaterial({color:0x24303a,roughness:.92}));
   inner.rotation.x=-Math.PI/2; inner.position.y=-.548; group.add(inner);
   [4.4,8.2,12.8].forEach(r=>{const ring=new THREE.Mesh(new THREE.RingGeometry(r,r+.08,80),new THREE.MeshBasicMaterial({color:0x53dfff,transparent:true,opacity:.26,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=-.538;group.add(ring);});
   const bannerMat=new THREE.MeshStandardMaterial({color:0x233240,roughness:.84});
   [[0,-23.8,68,.6],[0,23.8,68,.6],[-33.8,0,.6,48],[33.8,0,.6,48]].forEach(w=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w[2],2.6,w[3]),bannerMat);m.position.set(w[0],.15,w[1]);group.add(m);});
   [-8.5,0,8.5].forEach((x,i)=>{const base=new THREE.Mesh(new THREE.CylinderGeometry(.55,.72,1.15,10),new THREE.MeshStandardMaterial({color:0x394955,roughness:.86}));base.position.set(x,.0,7.0);group.add(base);const crystal=new THREE.Mesh(new THREE.OctahedronGeometry(.58),new THREE.MeshStandardMaterial({color:i===1?0xffc96a:0x72e5a5,emissive:i===1?0xffc96a:0x72e5a5,emissiveIntensity:.32,roughness:.2}));crystal.position.set(x,1.15,7.0);group.add(crystal);});
  } else if(this.theme==='serpent'){
   const floor=new THREE.Mesh(new THREE.CircleGeometry(40,104),new THREE.MeshStandardMaterial({color:0x362d24,roughness:.97,metalness:.02}));
   floor.rotation.x=-Math.PI/2; floor.position.y=-.55; group.add(floor);

   const centerDisc=new THREE.Mesh(new THREE.CircleGeometry(7.1,64),new THREE.MeshStandardMaterial({color:0x47372b,roughness:.95}));
   centerDisc.rotation.x=-Math.PI/2; centerDisc.position.y=-.545; group.add(centerDisc);
   const inner=new THREE.Mesh(new THREE.RingGeometry(5.8,13.6,80),new THREE.MeshBasicMaterial({color:0xb36f2d,transparent:true,opacity:.19,side:THREE.DoubleSide}));
   inner.rotation.x=-Math.PI/2; inner.position.y=-.539; group.add(inner);
   const rune=new THREE.Mesh(new THREE.RingGeometry(9.1,9.38,72),new THREE.MeshBasicMaterial({color:0xffc36b,transparent:true,opacity:.22,side:THREE.DoubleSide}));
   rune.rotation.x=-Math.PI/2; rune.position.y=-.537; group.add(rune);
   [4.1,11.6,17.5].forEach(r=>{
    const ring=new THREE.Mesh(new THREE.RingGeometry(r,r+.06,88),new THREE.MeshBasicMaterial({color:0x7f5131,transparent:true,opacity:.32,side:THREE.DoubleSide}));
    ring.rotation.x=-Math.PI/2; ring.position.y=-.536; group.add(ring);
   });

   const backWall=new THREE.Mesh(new THREE.BoxGeometry(28,10.2,1.2),new THREE.MeshStandardMaterial({color:0x594537,roughness:.92}));
   backWall.position.set(0,3.8,-25.6); group.add(backWall);

   const gateLeft=new THREE.Mesh(new THREE.BoxGeometry(3.65,9.1,3.0),new THREE.MeshStandardMaterial({color:0x5d4a3a,roughness:.88}));
   gateLeft.position.set(-5.2,3.5,-24.8); group.add(gateLeft);
   const gateRight=gateLeft.clone(); gateRight.position.x=5.2; group.add(gateRight);
   const lintel=new THREE.Mesh(new THREE.BoxGeometry(14.2,2.25,3.0),new THREE.MeshStandardMaterial({color:0x6e5844,roughness:.85}));
   lintel.position.set(0,8.25,-17.2); group.add(lintel);
   const portalGlow=new THREE.Mesh(new THREE.PlaneGeometry(8.8,7.0),new THREE.MeshBasicMaterial({color:0xffd47f,transparent:true,opacity:.74}));
   portalGlow.position.set(0,3.7,-23.25); group.add(portalGlow);

   const serpentMat=new THREE.MeshStandardMaterial({color:0x7d664d,roughness:.74});
   const serpentBody=new THREE.Mesh(new THREE.TorusGeometry(2.55,.37,14,38,Math.PI),serpentMat);
   serpentBody.rotation.z=Math.PI; serpentBody.position.set(0,9.0,-23.52); group.add(serpentBody);
   const serpentHead=new THREE.Mesh(new THREE.ConeGeometry(.72,1.35,5),serpentMat);
   serpentHead.rotation.z=Math.PI; serpentHead.position.set(0,8.62,-23.52); group.add(serpentHead);

   const statueMat=new THREE.MeshStandardMaterial({color:0x454851,roughness:.82});
   const makeWarden=(x)=>{
    const w=new THREE.Group();
    const body=new THREE.Mesh(new THREE.CylinderGeometry(.78,1.12,6.3,10),statueMat); body.position.y=3.1; w.add(body);
    const hood=new THREE.Mesh(new THREE.ConeGeometry(.9,1.8,10),statueMat); hood.position.y=6.08; w.add(hood);
    const sword=new THREE.Mesh(new THREE.BoxGeometry(.24,5.1,.24),new THREE.MeshStandardMaterial({color:0x1b1f26,metalness:.35,roughness:.42})); sword.position.set(0,2.15,.66); w.add(sword);
    w.position.set(x,0,-24.0); group.add(w);
   };
   makeWarden(-8.3); makeWarden(8.3);

   const brazierMat=new THREE.MeshStandardMaterial({color:0x2c2624,roughness:.72});
   const flameMat=new THREE.MeshBasicMaterial({color:0xffba4a,transparent:true,opacity:.95});
   [-14.6,14.6].forEach(x=>{
    const b=new THREE.Mesh(new THREE.CylinderGeometry(.92,1.12,.9,12),brazierMat); b.position.set(x,.02,-23.6); group.add(b);
    const f=new THREE.Mesh(new THREE.SphereGeometry(.76,12,10),flameMat); f.position.set(x,1.12,-23.6); f.scale.y=1.42; group.add(f);
   });

   this.pillars.forEach((p,idx)=>{
    const g=new THREE.Group();
    const base=new THREE.Mesh(new THREE.CylinderGeometry(p.r,p.r,5.3,24),new THREE.MeshStandardMaterial({color:idx===4?0x6a5540:0x4e4338,roughness:.88}));
    base.position.y=2.1; g.add(base);
    const midBand=new THREE.Mesh(new THREE.TorusGeometry(p.r*.92,.14,8,28),new THREE.MeshStandardMaterial({color:0x8d6d49,roughness:.66}));
    midBand.rotation.x=Math.PI/2; midBand.position.y=2.35; g.add(midBand);
    const cap=new THREE.Mesh(new THREE.TorusGeometry(p.r*.96,.16,8,28),new THREE.MeshStandardMaterial({color:0x9c7c59,roughness:.65}));
    cap.rotation.x=Math.PI/2; cap.position.y=4.55; g.add(cap);
    const glow=new THREE.Mesh(new THREE.RingGeometry(p.r*1.08,p.r*1.2,28),new THREE.MeshBasicMaterial({color:0xffab46,transparent:true,opacity:.22,side:THREE.DoubleSide}));
    glow.rotation.x=-Math.PI/2; glow.position.y=.02; g.add(glow);
    g.position.set(p.x,0,p.z); group.add(g);
   });

   [-20.4,-18.0,-15.8,15.8,18.0,20.4].forEach(x=>{
    const shard=new THREE.Mesh(new THREE.BoxGeometry(.9,2.8,.9),new THREE.MeshStandardMaterial({color:0x4b3b31,roughness:.86}));
    shard.position.set(x,.8,(x<0?11.8:-11.8)); shard.rotation.y=(Math.abs(x)%2)*.33; group.add(shard);
   });

   [[0,-23.8,68,.6],[0,23.8,68,.6],[-33.8,0,.6,48],[33.8,0,.6,48]].forEach(w=>{
    const m=new THREE.Mesh(new THREE.BoxGeometry(w[2],2.6,w[3]),new THREE.MeshStandardMaterial({color:0x392f2a,roughness:.95}));
    m.position.set(w[0],.15,w[1]); group.add(m);
   });
  } else {
   const floor=new THREE.Mesh(new THREE.CircleGeometry(40,104),new THREE.MeshStandardMaterial({color:0x18242f,roughness:.92,metalness:.04}));
   floor.rotation.x=-Math.PI/2; floor.position.y=-.55; group.add(floor);

   const centre=new THREE.Mesh(new THREE.CircleGeometry(6.5,48),new THREE.MeshStandardMaterial({color:0x21323f,roughness:.9}));
   centre.rotation.x=-Math.PI/2; centre.position.y=-.548; group.add(centre);
   const rune=new THREE.Mesh(new THREE.RingGeometry(7.3,7.52,72),new THREE.MeshBasicMaterial({color:0x44d4ff,transparent:true,opacity:.22,side:THREE.DoubleSide}));
   rune.rotation.x=-Math.PI/2; rune.position.y=-.538; group.add(rune);
   [4.4,10.8,15.7,20.2].forEach(r=>{
    const ring=new THREE.Mesh(new THREE.RingGeometry(r,r+.055,72),new THREE.MeshBasicMaterial({color:0x245062,transparent:true,opacity:.56,side:THREE.DoubleSide}));
    ring.rotation.x=-Math.PI/2; ring.position.y=-.536; group.add(ring);
   });
   [[0,0,22,.045],[0,Math.PI/2,22,.045],[0,Math.PI/4,18,.038],[0,-Math.PI/4,18,.038]].forEach(line=>{
    const strip=new THREE.Mesh(new THREE.BoxGeometry(line[2],.001,line[3]),new THREE.MeshBasicMaterial({color:0x2e6d85,transparent:true,opacity:.5}));
    strip.rotation.x=-Math.PI/2; strip.rotation.z=line[1]; strip.position.y=-.534; group.add(strip);
   });

   this.pillars.forEach((p,idx)=>{
    const pillar=new THREE.Group();
    const base=new THREE.Mesh(new THREE.CylinderGeometry(p.r,p.r,6.0,20),new THREE.MeshStandardMaterial({color:0x405a69,roughness:.84}));
    base.position.y=2.35; pillar.add(base);
    const band=new THREE.Mesh(new THREE.TorusGeometry(p.r*.9,.12,8,24),new THREE.MeshStandardMaterial({color:0x729bad,roughness:.5}));
    band.rotation.x=Math.PI/2; band.position.y=2.55; pillar.add(band);
    const crystal=new THREE.Mesh(new THREE.OctahedronGeometry(.82),new THREE.MeshStandardMaterial({color:0x49d7ff,emissive:0x49d7ff,emissiveIntensity:.42,roughness:.18,metalness:.22}));
    crystal.position.y=5.95; pillar.add(crystal);
    const glow=new THREE.Mesh(new THREE.RingGeometry(p.r*1.05,p.r*1.18,24),new THREE.MeshBasicMaterial({color:0x45daff,transparent:true,opacity:.3,side:THREE.DoubleSide}));
    glow.rotation.x=-Math.PI/2; glow.position.y=.02; pillar.add(glow);
    pillar.position.set(p.x,0,p.z); group.add(pillar);

    const sideRune=new THREE.Mesh(new THREE.RingGeometry(.34,.48,18),new THREE.MeshBasicMaterial({color:0x6ce4ff,transparent:true,opacity:.36,side:THREE.DoubleSide}));
    sideRune.rotation.x=-Math.PI/2; sideRune.position.set(p.x*0.86,-.538,p.z*0.86); group.add(sideRune);
   });

   const wallMat=new THREE.MeshStandardMaterial({color:0x233746,roughness:.85});
   [[0,-23.8,68,.6],[0,23.8,68,.6],[-33.8,0,.6,48],[33.8,0,.6,48]].forEach(w=>{
    const m=new THREE.Mesh(new THREE.BoxGeometry(w[2],2.6,w[3]),wallMat); m.position.set(w[0],.15,w[1]); group.add(m);
   });

   const outerCrystals=[[-18.7,0,-13.8],[-18.7,0,13.8],[18.7,0,-13.8],[18.7,0,13.8]];
   outerCrystals.forEach(([x,y,z])=>{
    const b=new THREE.Mesh(new THREE.CylinderGeometry(.5,.62,1.2,8),new THREE.MeshStandardMaterial({color:0x314653,roughness:.86}));
    b.position.set(x,.04,z); group.add(b);
    const c=new THREE.Mesh(new THREE.OctahedronGeometry(.58),new THREE.MeshStandardMaterial({color:0x55ddff,emissive:0x4ed8ff,emissiveIntensity:.3,roughness:.24}));
    c.position.set(x,1.1,z); group.add(c);
   });
  }
 }
 constrain(pos){
  pos.x=clamp(pos.x,-BALANCE.arenaX,BALANCE.arenaX);
  pos.z=clamp(pos.z,-BALANCE.arenaZ,BALANCE.arenaZ);
  for(const p of [...this.pillars,...this.colliders]){
   let dx=pos.x-p.x,dz=pos.z-p.z,d=Math.hypot(dx,dz),min=p.r+BALANCE.unitRadius;
   if(d<min){d=d||.001;pos.x=p.x+dx/d*min;pos.z=p.z+dz/d*min;}
  }
 }
 blockingPillar(a,b){
  const vx=b.x-a.x,vz=b.z-a.z,len2=vx*vx+vz*vz||.0001;
  for(const p of [...this.pillars,...this.colliders]){
   const t=clamp(((p.x-a.x)*vx+(p.z-a.z)*vz)/len2,0,1),cx=a.x+vx*t,cz=a.z+vz*t;
   if(Math.hypot(cx-p.x,cz-p.z)<p.r+.18)return p;
  }
  return null;
 }
 los(a,b){return !this.blockingPillar(a,b);}
}

class Character {
 constructor(game,o){Object.assign(this,o);this.game=game;this.netId=(o&&o.netId!=null)?o.netId:(Character._nid=(Character._nid||0)+1);this.info=CLASS_INFO[this.cls];this.gearStats=(this.isPlayer&&game)?game.getEquippedStats(this.cls):((this.team==='ally'&&game)?game.getAllyScaledStats(this.cls):((this.team==='enemy'&&game)?game.getEnemyScaledStats(this.cls):blankStats()));this.gearPieceCount=this.isPlayer&&game?game.getEquippedItems(this.cls).length:((this.team==='ally'&&game)?(game.allyGearProfile||[]).length:((this.team==='enemy'&&game)?(game.enemyGearProfile||[]).length:0));const baseHp=(this.cls==='sage'||this.cls==='pala'||this.cls==='disc')?BALANCE.healerHP:BALANCE.dpsHP,staminaHealth=Math.round((this.gearStats.Stamina||0)*.78),vitalityHealth=Math.min(300,Math.round((this.gearStats.Vitality||0)*.50));this.maxHp=Math.round((baseHp+staminaHealth+vitalityHealth)*classTalentStaminaMult(this.cls)*1.10);this.hp=this.maxHp;const baseResource=this.info.resource==='mana'?100+Math.min(60,Math.round((this.gearStats.Mana||0)*.18)):100;this.maxResource=this.cls==='soul'?Math.round(baseResource*1.15):baseResource;this.resource=this.maxResource;this.alive=true;this.shield=0;this.gcd=0;this.cds=Array(AB[this.cls].length).fill(0);this.tempestLock=0;this.effects=[];this._effectCache=new Map();this._effectCacheToken=-1;this.cast=null;this.dr={stun:{level:0,until:0},incap:{level:0,until:0},disorient:{level:0,until:0},fear:{level:0,until:0},root:{level:0,until:0}};this.stats={damage:0,healing:0,absorb:0,interrupts:0,kb:0,damageByAbility:{},damageByTarget:{},healingByAbility:{},healingByTarget:{}};this.velocity={x:0,z:0};this.walkPhase=Math.random()*Math.PI*2;this.motion=0;this.lastX=this.x;this.lastZ=this.z;this.visualX=this.x;this.visualZ=this.z;this.jumpY=0;this.jumpVel=0;this.mounted=false;this.combatUntil=0;this.trinketCd=0;this.basicAttackCd=.25+Math.random()*.35;this.combatAnim=null;this.aiMountDelay=.15+Math.random()*.45;this.moveSpeed=5.15;this.createMesh();}
 createMesh(){
  this.mesh=new THREE.Group();
  const teamCol=this.team==='ally'?COLORS.ally:COLORS.enemy;
  const metalDark=new THREE.MeshStandardMaterial({color:0x2e323a,roughness:.55,metalness:.25});
  const trimMat=new THREE.MeshStandardMaterial({color:teamCol,emissive:teamCol,emissiveIntensity:.28,roughness:.38});
  const skinMat=new THREE.MeshStandardMaterial({color:0xdfe6ef,roughness:.58});
  const bodyMat=new THREE.MeshStandardMaterial({color:this.info.colour,emissive:this.info.colour,emissiveIntensity:.24,roughness:.4});
  const markBase=(mesh,...slots)=>{mesh.userData.baseGearSlots=slots;return mesh;};
  this.bodyMat=bodyMat;
  const pelvis=markBase(new THREE.Mesh(new THREE.CylinderGeometry(.34,.42,.38,8), bodyMat),'Chest','Waist','Legs'); pelvis.position.y=.55; this.mesh.add(pelvis);
  const torso=markBase(new THREE.Mesh(new THREE.CapsuleGeometry(.38,.78,5,10), bodyMat),'Chest'); torso.position.y=1.18; this.mesh.add(torso);
  const neck=new THREE.Mesh(new THREE.CylinderGeometry(.11,.12,.22,10), skinMat); neck.position.y=1.77; this.mesh.add(neck);
  const head=new THREE.Mesh(new THREE.SphereGeometry(.29,14,12), skinMat); head.position.y=2.03; this.mesh.add(head);
  const shoulderL=new THREE.Mesh(new THREE.SphereGeometry(.16,10,8), trimMat); shoulderL.position.set(-.43,1.46,0); this.mesh.add(shoulderL);
  const shoulderR=shoulderL.clone(); shoulderR.position.x=.43; this.mesh.add(shoulderR);
  const legL=new THREE.Mesh(new THREE.CylinderGeometry(.09,.11,.62,8), metalDark); legL.position.set(-.14,.17,0); this.mesh.add(legL);
  const legR=legL.clone(); legR.position.x=.14; this.mesh.add(legR);
  const armL=new THREE.Mesh(new THREE.CylinderGeometry(.07,.08,.6,8), metalDark); armL.position.set(-.52,1.07,0); armL.rotation.z=.18; this.mesh.add(armL);
  const armR=armL.clone(); armR.position.x=.52; armR.rotation.z=-.18; this.mesh.add(armR);
  this.legL=legL;this.legR=legR;this.armL=armL;this.armR=armR;this.torso=torso;this.pelvis=pelvis;
  const handMat=new THREE.MeshStandardMaterial({color:0xe9dfd3,emissive:this.info.colour,emissiveIntensity:.18,roughness:.45});
  this.handL=new THREE.Mesh(new THREE.SphereGeometry(.105,8,7),handMat);this.handL.position.set(-.54,.77,0);this.mesh.add(this.handL);
  this.handR=new THREE.Mesh(new THREE.SphereGeometry(.105,8,7),handMat);this.handR.position.set(.54,.77,0);this.mesh.add(this.handR);
  this.castOrb=new THREE.Mesh(new THREE.SphereGeometry(.16,10,8),new THREE.MeshStandardMaterial({color:this.info.colour,emissive:this.info.colour,emissiveIntensity:1.1,transparent:true,opacity:.94}));
  this.castOrb.position.set(0,1.18,-.38);this.castOrb.visible=false;this.mesh.add(this.castOrb);
  const aura=new THREE.Mesh(new THREE.RingGeometry(.78,.95,32),new THREE.MeshBasicMaterial({color:teamCol,transparent:true,opacity:.92,side:THREE.DoubleSide})); aura.rotation.x=-Math.PI/2;aura.position.y=.03;this.mesh.add(aura);this.aura=aura;
  const select=new THREE.Mesh(new THREE.RingGeometry(1.04,1.34,48),new THREE.MeshBasicMaterial({color:0xffd052,transparent:true,opacity:1,side:THREE.DoubleSide,depthWrite:false})); select.rotation.x=-Math.PI/2;select.position.y=.055;select.visible=false;this.mesh.add(select);this.selectRing=select;
  const beacon=new THREE.Group();beacon.visible=false;
  const beaconMat=new THREE.MeshBasicMaterial({color:0xffd052,transparent:true,opacity:.72,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});
  const outer=new THREE.Mesh(new THREE.TorusGeometry(1.48,.035,8,64),beaconMat);outer.rotation.x=Math.PI/2;outer.position.y=.075;beacon.add(outer);
  const diamond=new THREE.Mesh(new THREE.OctahedronGeometry(.16),beaconMat);diamond.position.y=2.78;beacon.add(diamond);
  const stem=new THREE.Mesh(new THREE.CylinderGeometry(.018,.018,1.9,6),beaconMat);stem.position.y=1.65;beacon.add(stem);
  this.mesh.add(beacon);this.targetBeacon=beacon;

  if(this.cls==='flame'){
    const skirt=new THREE.Mesh(new THREE.CylinderGeometry(.52,.62,.92,8,1,true), new THREE.MeshStandardMaterial({color:0x6b2f16,emissive:0xff7436,emissiveIntensity:.12,side:THREE.DoubleSide})); skirt.position.y=.82; markBase(skirt,'Chest','Legs'); this.mesh.add(skirt);
    const mantle=new THREE.Mesh(new THREE.ConeGeometry(.36,.52,8), trimMat); mantle.position.y=2.34; markBase(mantle,'Head'); this.mesh.add(mantle);
    const staff=new THREE.Mesh(new THREE.CylinderGeometry(.04,.04,1.28,6), metalDark); staff.position.set(.74,1.25,0); staff.rotation.z=.16; markBase(staff,'Weapon'); this.mesh.add(staff);
    const crystal=new THREE.Mesh(new THREE.OctahedronGeometry(.16), new THREE.MeshStandardMaterial({color:0xffc259,emissive:0xffaa33,emissiveIntensity:.85})); crystal.position.set(.84,1.87,0); markBase(crystal,'Weapon'); this.mesh.add(crystal);
    const offOrb=new THREE.Mesh(new THREE.SphereGeometry(.1,10,8), new THREE.MeshBasicMaterial({color:0xff6a2c})); offOrb.position.set(-.62,1.42,.05); markBase(offOrb,'Trinket'); this.mesh.add(offOrb);
  }
  if(this.cls==='shadow'){
    const hood=new THREE.Mesh(new THREE.ConeGeometry(.34,.52,8), new THREE.MeshStandardMaterial({color:0x27143b,emissive:0x7b43d7,emissiveIntensity:.18})); hood.position.y=2.23; markBase(hood,'Head'); this.mesh.add(hood);
    const cape=new THREE.Mesh(new THREE.BoxGeometry(.62,.92,.06), new THREE.MeshStandardMaterial({color:0x21142e,transparent:true,opacity:.85})); cape.position.set(0,1.1,-.26); markBase(cape,'Back'); this.mesh.add(cape);
    const daggerL=new THREE.Mesh(new THREE.BoxGeometry(.05,.48,.1), new THREE.MeshStandardMaterial({color:0xc4c0ff,emissive:0x8f56ec,emissiveIntensity:.45})); daggerL.position.set(-.7,.98,.08); daggerL.rotation.z=.42; markBase(daggerL,'Weapon'); this.mesh.add(daggerL);
    const daggerR=daggerL.clone(); daggerR.position.x=.7; daggerR.rotation.z=-.42; markBase(daggerR,'Weapon'); this.mesh.add(daggerR);
  }
  if(this.cls==='storm'){
    const collar=new THREE.Mesh(new THREE.TorusGeometry(.42,.05,8,18), trimMat); collar.rotation.x=Math.PI/2; collar.position.y=1.58; markBase(collar,'Shoulders'); this.mesh.add(collar);
    const rod=new THREE.Mesh(new THREE.CylinderGeometry(.03,.03,1.15,6), metalDark); rod.position.set(.75,1.22,0); rod.rotation.z=.12; markBase(rod,'Weapon'); this.mesh.add(rod);
    const forkA=new THREE.Mesh(new THREE.BoxGeometry(.04,.24,.04), trimMat); forkA.position.set(.82,1.86,.08); forkA.rotation.z=.45; markBase(forkA,'Weapon'); this.mesh.add(forkA);
    const forkB=forkA.clone(); forkB.position.z=-.08; forkB.rotation.z=-.45; markBase(forkB,'Weapon'); this.mesh.add(forkB);
    const charge=new THREE.Mesh(new THREE.TorusGeometry(.18,.03,6,16), new THREE.MeshBasicMaterial({color:0x84f4ff})); charge.rotation.y=Math.PI/2; charge.position.set(-.62,1.64,0); markBase(charge,'Trinket'); this.mesh.add(charge);
  }
  if(this.cls==='wind'){
    const sash=new THREE.Mesh(new THREE.TorusGeometry(.39,.07,7,18),new THREE.MeshStandardMaterial({color:0xf3d36d,emissive:0xb98b28,emissiveIntensity:.24}));sash.rotation.x=Math.PI/2;sash.position.y=1.02;markBase(sash,'Waist');this.mesh.add(sash);
    const wrapsL=new THREE.Mesh(new THREE.CylinderGeometry(.105,.105,.34,8),new THREE.MeshStandardMaterial({color:0xead8a6,roughness:.7}));wrapsL.position.set(-.5,1.03,0);markBase(wrapsL,'Wrist','Gloves');this.mesh.add(wrapsL);
    const wrapsR=wrapsL.clone();wrapsR.position.x=.5;markBase(wrapsR,'Wrist','Gloves');this.mesh.add(wrapsR);
    const headband=new THREE.Mesh(new THREE.TorusGeometry(.3,.028,6,18),new THREE.MeshBasicMaterial({color:0x72e5a5}));headband.rotation.x=Math.PI/2;headband.position.y=2.07;markBase(headband,'Head');this.mesh.add(headband);
    const ribbon=new THREE.Mesh(new THREE.BoxGeometry(.04,.05,.5),new THREE.MeshBasicMaterial({color:0x72e5a5,transparent:true,opacity:.9}));ribbon.position.set(0,2.05,-.35);markBase(ribbon,'Head');this.mesh.add(ribbon);
    const fistL=new THREE.Mesh(new THREE.SphereGeometry(.11,8,8),new THREE.MeshStandardMaterial({color:0xffe098,emissive:0x72e5a5,emissiveIntensity:.52}));fistL.position.set(-.62,1.02,.05);markBase(fistL,'Weapon');this.mesh.add(fistL);
    const fistR=fistL.clone();fistR.position.x=.62;markBase(fistR,'Weapon');this.mesh.add(fistR);
  }
  if(this.cls==='soul'){
    const shroud=new THREE.Mesh(new THREE.CylinderGeometry(.48,.64,1.0,10,1,true),new THREE.MeshStandardMaterial({color:0x2b153b,emissive:0xb85cff,emissiveIntensity:.18,side:THREE.DoubleSide}));shroud.position.y=.8;markBase(shroud,'Chest','Legs');this.mesh.add(shroud);
    const tome=new THREE.Mesh(new THREE.BoxGeometry(.32,.4,.08),new THREE.MeshStandardMaterial({color:0x23142c,emissive:0xb85cff,emissiveIntensity:.35}));tome.position.set(.68,1.3,.05);tome.rotation.y=-.25;markBase(tome,'Weapon');this.mesh.add(tome);
    const soulOrb=new THREE.Mesh(new THREE.SphereGeometry(.13,10,8),new THREE.MeshStandardMaterial({color:0xebc1ff,emissive:0xb85cff,emissiveIntensity:1}));soulOrb.position.set(-.62,1.52,0);markBase(soulOrb,'Trinket');this.mesh.add(soulOrb);
  }
  if(this.cls==='sage'){
    const robe=new THREE.Mesh(new THREE.CylinderGeometry(.5,.65,1.02,10,1,true), new THREE.MeshStandardMaterial({color:0x20523a,emissive:0x53d384,emissiveIntensity:.12,side:THREE.DoubleSide})); robe.position.y=.8; markBase(robe,'Chest','Legs'); this.mesh.add(robe);
    const staff=new THREE.Mesh(new THREE.CylinderGeometry(.04,.04,1.3,6), metalDark); staff.position.set(.74,1.25,0); staff.rotation.z=.15; markBase(staff,'Weapon'); this.mesh.add(staff);
    const leaf=new THREE.Mesh(new THREE.SphereGeometry(.12,10,8), new THREE.MeshBasicMaterial({color:0xb4ffb2})); leaf.scale.set(.65,1.1,.4); leaf.position.set(.82,1.92,0); markBase(leaf,'Weapon'); this.mesh.add(leaf);
  }

  if(this.cls==='disc'){
    const whiteMat=new THREE.MeshStandardMaterial({color:0xf1f2f7,emissive:0xc7ccff,emissiveIntensity:.18,roughness:.35,metalness:.10,side:THREE.DoubleSide});
    const goldMat=new THREE.MeshStandardMaterial({color:0xe8d18a,emissive:0xffe9a8,emissiveIntensity:.38,roughness:.28,metalness:.36});
    const robe=new THREE.Mesh(new THREE.CylinderGeometry(.51,.67,1.04,12,1,true),whiteMat);robe.position.y=.79;markBase(robe,'Chest','Legs');this.mesh.add(robe);
    const mantle=new THREE.Mesh(new THREE.BoxGeometry(.92,.15,.34),goldMat);mantle.position.y=1.54;markBase(mantle,'Shoulders');this.mesh.add(mantle);
    const staff=new THREE.Mesh(new THREE.CylinderGeometry(.035,.045,1.34,8),goldMat);staff.position.set(.73,1.24,0);staff.rotation.z=.14;markBase(staff,'Weapon');this.mesh.add(staff);
    const star=new THREE.Mesh(new THREE.OctahedronGeometry(.15),new THREE.MeshStandardMaterial({color:0xffffff,emissive:0xb9c6ff,emissiveIntensity:1.2}));star.position.set(.82,1.94,0);markBase(star,'Weapon');this.mesh.add(star);
    const darkOrb=new THREE.Mesh(new THREE.SphereGeometry(.09,10,8),new THREE.MeshStandardMaterial({color:0x67567f,emissive:0x8b6db4,emissiveIntensity:.85}));darkOrb.position.set(-.57,1.47,.12);markBase(darkOrb,'Trinket');this.mesh.add(darkOrb);
    const lightOrb=new THREE.Mesh(new THREE.SphereGeometry(.09,10,8),new THREE.MeshStandardMaterial({color:0xffffff,emissive:0xffefaf,emissiveIntensity:1.1}));lightOrb.position.set(-.57,1.47,-.12);markBase(lightOrb,'Trinket');this.mesh.add(lightOrb);
    this.discWings=new THREE.Group();this.discWings.visible=false;
    const makeDiscWing=(side)=>{const wing=new THREE.Group();for(let i=0;i<4;i++){const mat=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.83,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});const feather=new THREE.Mesh(new THREE.PlaneGeometry(.28-.025*i,.72-.07*i),mat);feather.position.set(side*(.38+.12*i),1.62-.035*i,-.07);feather.rotation.z=side*(.86+i*.16);feather.rotation.y=side*.12;wing.add(feather);}return wing;};
    this.discWings.add(makeDiscWing(-1),makeDiscWing(1));this.mesh.add(this.discWings);
  }
  if(this.cls==='pala'){
    const plate=new THREE.Mesh(new THREE.CylinderGeometry(.5,.62,1.0,10,1,true),new THREE.MeshStandardMaterial({color:0xd8b14f,emissive:0xffcf63,emissiveIntensity:.18,metalness:.36,roughness:.38,side:THREE.DoubleSide}));plate.position.y=.8;markBase(plate,'Chest','Legs');this.mesh.add(plate);
    const mantle=new THREE.Mesh(new THREE.BoxGeometry(.92,.16,.35),new THREE.MeshStandardMaterial({color:0xf6dd95,emissive:0xffd267,emissiveIntensity:.18,metalness:.32,roughness:.35}));mantle.position.y=1.54;markBase(mantle,'Shoulders');this.mesh.add(mantle);
    const shield=new THREE.Mesh(new THREE.CylinderGeometry(.33,.33,.08,8),new THREE.MeshStandardMaterial({color:0xf3c953,emissive:0xffda72,emissiveIntensity:.32,metalness:.4,roughness:.32}));shield.rotation.z=Math.PI/2;shield.position.set(-.69,1.15,0);markBase(shield,'Weapon');this.mesh.add(shield);
    const crossV=new THREE.Mesh(new THREE.BoxGeometry(.03,.30,.03),new THREE.MeshBasicMaterial({color:0xfff1b2}));crossV.position.set(-.735,1.15,0);markBase(crossV,'Weapon');this.mesh.add(crossV);
    const crossH=new THREE.Mesh(new THREE.BoxGeometry(.03,.03,.23),new THREE.MeshBasicMaterial({color:0xfff1b2}));crossH.position.set(-.735,1.15,0);markBase(crossH,'Weapon');this.mesh.add(crossH);
    const hammer=new THREE.Mesh(new THREE.CylinderGeometry(.035,.04,1.05,7),metalDark);hammer.position.set(.72,1.10,0);hammer.rotation.z=-.23;markBase(hammer,'Weapon');this.mesh.add(hammer);
    const head=new THREE.Mesh(new THREE.BoxGeometry(.34,.17,.18),new THREE.MeshStandardMaterial({color:0xf3cf67,emissive:0xffd466,emissiveIntensity:.25,metalness:.38,roughness:.3}));head.position.set(.84,1.62,0);markBase(head,'Weapon');this.mesh.add(head);

    this.palaWings=new THREE.Group();
    this.palaWings.visible=false;
    const wingMatOuter=new THREE.MeshBasicMaterial({color:0xffdd78,transparent:true,opacity:.95,side:THREE.DoubleSide});
    const wingMatInner=new THREE.MeshBasicMaterial({color:0xffffd8,transparent:true,opacity:.98,side:THREE.DoubleSide});
    for(const side of [-1,1]){
      const wing=new THREE.Group();
      for(let i=0;i<5;i++){
        const feather=new THREE.Mesh(new THREE.PlaneGeometry(.55-.04*i,1.2-.12*i),i<2?wingMatInner:wingMatOuter);
        feather.position.set(side*(.55+.18*i),1.7-.07*i,-.08+.02*i);
        feather.rotation.z=side*(1.08+i*.18);
        feather.rotation.y=side*(.20+i*.04);
        wing.add(feather);
      }
      const arm=new THREE.Mesh(new THREE.CylinderGeometry(.03,.05,.7,6),new THREE.MeshBasicMaterial({color:0xffe7a2,transparent:true,opacity:.9}));
      arm.position.set(side*.28,1.58,.03); arm.rotation.z=side*1.02; wing.add(arm);
      this.palaWings.add(wing);
    }
    this.mesh.add(this.palaWings);

    this.divineSteedMount=new THREE.Group();
    this.divineSteedMount.visible=false;
    const steedBody=new THREE.Mesh(new THREE.CylinderGeometry(.36,.46,1.65,10),new THREE.MeshStandardMaterial({color:0xf3ead0,emissive:0xffe8a2,emissiveIntensity:.22,roughness:.52,metalness:.08}));
    steedBody.rotation.z=Math.PI/2; steedBody.position.set(0,.55,0); this.divineSteedMount.add(steedBody);
    const steedNeck=new THREE.Mesh(new THREE.CylinderGeometry(.12,.16,.68,8),new THREE.MeshStandardMaterial({color:0xf1e2bf,emissive:0xffe7a8,emissiveIntensity:.2,roughness:.55}));
    steedNeck.position.set(.82,.90,0); steedNeck.rotation.z=-.55; this.divineSteedMount.add(steedNeck);
    const steedHead=new THREE.Mesh(new THREE.BoxGeometry(.34,.24,.18),new THREE.MeshStandardMaterial({color:0xf7edc7,emissive:0xffecb2,emissiveIntensity:.22,roughness:.48}));
    steedHead.position.set(1.05,1.12,0); steedHead.rotation.z=-.15; this.divineSteedMount.add(steedHead);
    for(const lx of [-.45,.15]){
      for(const lz of [-.18,.18]){
        const leg=new THREE.Mesh(new THREE.CylinderGeometry(.045,.055,.72,6),new THREE.MeshStandardMaterial({color:0xf0ddb0,roughness:.58}));
        leg.position.set(lx,.10,lz); this.divineSteedMount.add(leg);
      }
    }
    const tail=new THREE.Mesh(new THREE.ConeGeometry(.09,.55,6),new THREE.MeshBasicMaterial({color:0xffe39a,transparent:true,opacity:.85}));
    tail.position.set(-.93,.74,0); tail.rotation.z=-1.1; this.divineSteedMount.add(tail);
    const mane=new THREE.Mesh(new THREE.BoxGeometry(.06,.42,.14),new THREE.MeshBasicMaterial({color:0xffedbf,transparent:true,opacity:.9}));
    mane.position.set(.88,1.05,0); mane.rotation.z=.55; this.divineSteedMount.add(mane);
    const steedHalo=new THREE.Mesh(new THREE.RingGeometry(.16,.24,18),new THREE.MeshBasicMaterial({color:0xfff5c2,transparent:true,opacity:.9,side:THREE.DoubleSide}));
    steedHalo.rotation.y=Math.PI/2; steedHalo.position.set(1.14,1.28,0); this.divineSteedMount.add(steedHalo);
    this.mesh.add(this.divineSteedMount);
  }

  const visibleGear=this.isPlayer?this.game.getEquippedItems(this.cls):(this.team==='ally'?this.game.getAllyScaledItems(this.cls):(this.team==='enemy'?this.game.getEnemyScaledItems(this.cls):[]));
  this.shadowmoonEquipped=this.cls==='warrior'&&hasShadowmoon(visibleGear);
  this.game.applyBaseGearVisibility(this.mesh,visibleGear);
  this.gearAppearance=this.game.attachGearAppearance(this.mesh,this.cls,visibleGear,false);
  this.prestigeVisual=buildPrestigeVisual(this.cls,visibleGear);
  if(this.prestigeVisual)this.mesh.add(this.prestigeVisual);

  this.polyVisual=new THREE.Group();
  const woolMat=new THREE.MeshStandardMaterial({color:0xfffaff,emissive:0xe9dfff,emissiveIntensity:.2,roughness:.88});
  const sheepDark=new THREE.MeshStandardMaterial({color:0x3b3341,roughness:.82});
  const sheepPink=new THREE.MeshStandardMaterial({color:0xffcbe8,roughness:.7});
  const woolBody=new THREE.Mesh(new THREE.SphereGeometry(.52,14,12),woolMat);woolBody.scale.set(1.15,.82,.9);woolBody.position.set(0,.72,0);this.polyVisual.add(woolBody);
  [[-.38,.84,.02],[.38,.84,.02],[-.22,1.08,0],[.22,1.08,0],[0,.98,.25]].forEach(p=>{const puff=new THREE.Mesh(new THREE.SphereGeometry(.27,10,9),woolMat);puff.position.set(...p);this.polyVisual.add(puff);});
  const sheepHead=new THREE.Mesh(new THREE.SphereGeometry(.27,12,10),sheepDark);sheepHead.scale.set(.82,1,.82);sheepHead.position.set(0,.78,-.48);this.polyVisual.add(sheepHead);
  const muzzle=new THREE.Mesh(new THREE.SphereGeometry(.12,9,8),sheepPink);muzzle.position.set(0,.72,-.69);this.polyVisual.add(muzzle);
  const earL=new THREE.Mesh(new THREE.SphereGeometry(.13,8,8),sheepDark);earL.scale.set(1.4,.52,.6);earL.position.set(-.27,.92,-.46);earL.rotation.z=.42;this.polyVisual.add(earL);
  const earR=earL.clone();earR.position.x=.27;earR.rotation.z=-.42;this.polyVisual.add(earR);
  [[-.28,.27,-.18],[.28,.27,-.18],[-.28,.27,.18],[.28,.27,.18]].forEach(p=>{const leg=new THREE.Mesh(new THREE.CylinderGeometry(.045,.055,.42,7),sheepDark);leg.position.set(...p);this.polyVisual.add(leg);});
  const hexStar=new THREE.Mesh(new THREE.OctahedronGeometry(.11),new THREE.MeshBasicMaterial({color:0xdcb8ff}));hexStar.position.set(0,1.58,0);this.polyVisual.add(hexStar);
  const hexRing=new THREE.Mesh(new THREE.RingGeometry(.58,.66,26),new THREE.MeshBasicMaterial({color:0xe0bdff,transparent:true,opacity:.78,side:THREE.DoubleSide}));hexRing.rotation.x=-Math.PI/2;hexRing.position.y=.06;this.polyVisual.add(hexRing);
  this.polyVisual.visible=false; this.mesh.add(this.polyVisual);

  this.createMountAppearance();

  // Large invisible selection capsule makes characters easy to click in shoulder-camera combat.
  this.clickHitbox=new THREE.Mesh(new THREE.CapsuleGeometry(.78,1.52,4,8),new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false}));
  this.clickHitbox.position.y=1.28;this.clickHitbox.userData.unit=this;this.mesh.add(this.clickHitbox);

  // --- AetherKit: swap the primitive body for the rigged outfit model ---
  this.modelGroup=(typeof AetherKit!=='undefined')?AetherKit.buildModelGroup(this.cls):null;
  this.rig=(this.modelGroup&&this.modelGroup.userData)?this.modelGroup.userData.rig:null;
  if(this.rig){
    this.mesh.add(this.modelGroup);
    applyPrestigeWeaponIllusion(this.modelGroup,this.cls,visibleGear);
    applyShadowmoonWeapon(this.modelGroup,visibleGear);
    this._keepVisible=new Set([this.aura,this.selectRing,this.targetBeacon,this.castOrb,this.polyVisual,this.mountVisual,this.palaWings,this.divineSteedMount,this.clickHitbox,this.modelGroup,this.gearAppearance,this.prestigeVisual,this.discWings].filter(Boolean));
    this.mesh.children.forEach(c=>{ if(!this._keepVisible.has(c)) c.visible=false; });
  }
  this.mesh.position.set(this.x,0,this.z); this.mesh.userData.unit=this; this.game.scene.add(this.mesh);
  this.plate=document.createElement('div');
  this.plate.className=`plate ${this.team}`;
  this.plate.innerHTML=`<div class="plate-cc"></div><div class="plate-name"></div><div class="bar"><div class="fill hp"></div><div class="shield-fill"></div></div><div class="plate-cast hidden"><div class="plate-cast-head"></div><div class="plate-cast-track"><span></span></div></div>`;
  this.plateHud={cc:this.plate.querySelector('.plate-cc'),name:this.plate.querySelector('.plate-name'),hp:this.plate.querySelector('.hp'),shield:this.plate.querySelector('.shield-fill'),cast:this.plate.querySelector('.plate-cast'),castHead:this.plate.querySelector('.plate-cast-head'),castFill:this.plate.querySelector('.plate-cast-track span')};
  $('#worldLabels').appendChild(this.plate);
 }
 createMountAppearance(){const def=mountDefinition(this.isPlayer?progression.activeMount:'skyhoof');this.mountData=def;if(this.mountVisual&&this.mountVisual.parent)this.mountVisual.parent.remove(this.mountVisual);this.mountVisual=buildMountVisual(def,false);this.mountLegs=this.mountVisual.userData.legs||[];this.mountHeadPivot=this.mountVisual.userData.headPivot||null;this.mountAura=this.mountVisual.userData.ring||null;this.mountVisual.visible=false;this.mesh.add(this.mountVisual);}
 has(type){const token=this.game?.effectQueryFrame||0;if(this._effectCacheToken!==token){this._effectCacheToken=token;this._effectCache.clear();}if(this._effectCache.has(type)){const cached=this._effectCache.get(type);return cached&&cached.time>0?cached:undefined;}const found=this.effects.find(e=>e.type===type&&e.time>0);this._effectCache.set(type,found||null);return found;}
 effect(type,duration,data={}){
  this._effectCache?.delete(type);
  if(this.cls==='shadow'&&['evasion','cloakShadows','defensive','stealth','smokePower','cheapReady','smokeBombReady'].includes(type))duration+=unitTalentRank(this,'shadow_veil_training')*.25;
  if(type==='smokeBomb'){const shadowSource=data.source||this.game?.units?.find(u=>u.team!==this.team&&u.cls==='shadow'&&u.alive);if(shadowSource)duration+=unitTalentRank(shadowSource,'smoketactics')*.25;}
  if(type==='sacrifice'&&data.source?.cls==='pala')duration+=unitTalentRank(data.source,'pala_sacred_vow')*.25;
  if(type==='defensive'&&this.cls==='flame'&&duration===4&&!Object.keys(data).length){
   const saved=this.has('alterTime');
   if(saved){
    this.x=saved.x;this.z=saved.z;this.hp=clamp(saved.hp,1,this.maxHp);this.game.arena.constrain(this);
   this.effects=this.effects.filter(e=>e!==saved);
    if(this.alterTimeFx?.obj)this.alterTimeFx.obj.dead=true;this.alterTimeFx=null;
    if(Number.isInteger(saved.slot)&&saved.slot>=0)this.cds[saved.slot]=60;
    const cue={type:'alterTimeReturnCue',time:.15,tick:1};this.effects.push(cue);
    this.game.vfxRing(this,0x79dfff,2.5);this.game.vfxGlyph(this,0xd7f5ff,.9);
    return cue;
   }
   const slot=(AB[this.cls]||[]).findIndex(a=>a.name==='Alter Time');
   const temporal={type:'alterTime',time:5,tick:1,x:this.x,z:this.z,hp:this.hp,slot};
   this.effects.push(temporal);this.game.vfxAlterTimeClock(this,5);this.game.vfxRing(this,0x79dfff,2.2);this.game.vfxGlyph(this,0xd7f5ff,.8);
   return temporal;
  }
  if(type==='warbreakerReady'){
   data={...data,pct:.30};
   this.effects=this.effects.filter(e=>e.type!=='warbreakerDamage');
  }
  const effectKey=data.effectKey||'';
  const existing=this.effects.find(e=>e.type===type&&(!effectKey||(e.effectKey||'')===effectKey));
  if(existing){if(['soulScar','agony','immolate','unstableAffliction'].includes(type)&&data.source?.cls==='soul'){const rank=unitTalentRank(data.source,'soul_curse_weaving');if(rank>0){data.source.effects=data.source.effects.filter(e=>e.type!=='curseWeavingPower');data.source.effect('curseWeavingPower',10,{pct:rank*.02});data.source.game.float(data.source,`CURSE WEAVING · NEXT HIT +${rank*2}%`,'info');}}existing.time=duration;Object.assign(existing,data);return existing;}
  const fireTalentSource=data.source?.cls==='flame'?data.source:(this.cls==='flame'?this:null);if(fireTalentSource&&['livingBomb','combustion','moltenArmor'].includes(type)){const rank=unitTalentRank(fireTalentSource,'flame_overheat');if(rank>0){fireTalentSource.effects=fireTalentSource.effects.filter(e=>e.type!=='overheatPower');fireTalentSource.effect('overheatPower',10,{pct:rank*.02});fireTalentSource.game.float(fireTalentSource,`OVERHEAT · CINDER BOLT +${rank*2}%`,'info');}}
  const e={type,time:duration,tick:1,...data};
  if(type==='touchOfDeath'){
   let weighted=Number(data.accumulated||0);
   Object.defineProperty(e,'accumulated',{enumerable:true,configurable:true,get(){return weighted;},set(next){const delta=Number(next)-weighted;weighted+=Math.max(0,delta)*1.5;}});
  }
  this.effects.push(e);if(type==='evasion')this.game?.vfxEvasion?.(this,duration);return e;
 }
 removeDispellable(){const order=['poly','sleep','gouge','blind','windIncap','fear','root','slow','livingBomb','karmaDot'];for(const type of order){const i=this.effects.findIndex(e=>e.type===type);if(i>=0){this.effects.splice(i,1);this._effectCache?.clear();return type;}}return null;}
 update(dt){if(!this.alive)return;if(this.gearAppearance?.userData?.tick)this.gearAppearance.userData.tick(dt);this.gcd=Math.max(0,this.gcd-dt);this.basicAttackCd=Math.max(0,(this.basicAttackCd||0)-dt);this.trinketCd=Math.max(0,this.trinketCd-dt);this.tempestLock=Math.max(0,(this.tempestLock||0)-dt);for(let i=0;i<this.cds.length;i++)this.cds[i]=Math.max(0,this.cds[i]-dt);
  if(this.cls==='flame'&&this.cast&&!this.cast.temperedFocusChecked){this.cast.temperedFocusChecked=true;const rank=unitTalentRank(this,'flame_tempered_focus'),pressured=rank>0&&this.game.units.some(u=>u.team!==this.team&&u.alive&&dist(this,u)<=8);if(pressured){this.effect('temperedFocus',2,{reduction:rank*.02});this.game.float(this,`TEMPERED FOCUS · ${rank*2}% WALL`,'info');}}
  const manaGear=1+Math.min(.30,(this.gearStats.Mana||0)*.00075);const disciplineManaMult=this.cls==='disc'?.88:1;const regen=this.info.resource==='energy'?BALANCE.energyRegen:((this.cls==='soul'?1.30:this.cls==='storm'?1.20:1)*((this.cls==='sage'||this.cls==='pala'||this.cls==='disc')?BALANCE.healerManaRegen:BALANCE.manaRegen)*manaGear*disciplineManaMult);this.resource=clamp(this.resource+regen*dt,0,this.maxResource);
  if(this.trainingDummy){const floor=this.maxHp*.80;if(this.hp<=floor+.5)this.dummyRegen=true;if(this.dummyRegen){this.hp=Math.min(this.maxHp,this.hp+this.maxHp*.11*dt);if(this.hp>=this.maxHp-.5)this.dummyRegen=false;}}
  const alterReturn=this.effects.find(e=>e.type==='alterTime'&&e.time>0&&e.time<=dt);
  if(alterReturn){this.x=alterReturn.x;this.z=alterReturn.z;this.hp=clamp(alterReturn.hp,1,this.maxHp);this.game.arena.constrain(this);const slot=Number(alterReturn.slot);if(Number.isInteger(slot)&&slot>=0)this.cds[slot]=60;if(this.alterTimeFx?.obj)this.alterTimeFx.obj.dead=true;this.alterTimeFx=null;this.game.vfxRing(this,0x79dfff,2.5);this.game.vfxGlyph(this,0xd7f5ff,.9);this.game.float(this,'ALTER TIME · RETURNED','info');}
  this.effects=this.effects.filter(e=>{e.time-=dt;if(this.game.netGuest){if(e.time<=0&&e.type==='shield')this.shield=0;return e.time>0;}if(['burn','poison','hot','trail','soulScar','agony','unstableAffliction','iceBlock','bleed','livingBomb','cauterizeDoom','karmaDot','flameShock','sharpenRenewal','slicingWinds'].includes(e.type)){e.tick-=dt;if(e.tick<=0){const vendettaFast=(e.source?.cls==='shadow'&&['bleed','poison'].includes(e.type)&&this.has('vendetta')?.source===e.source);const ghanirFast=e.type==='hot'&&e.source?.has&&e.source.has('ghanir');e.tick+=vendettaFast?Math.max(.35,(e.interval||1)*.5):(ghanirFast?Math.max(.25,(e.interval||1)*.5):(e.interval||1));if(e.type==='bladestorm'){this.game.units.filter(u=>u.team!==this.team&&u.alive&&dist(this,u)<=5.2).forEach(u=>this.game.damage(this,u,e.value||22,'Bladestorm Tick'));this.game.vfxCyclone(this,COLORS.warrior,.55);/* BLADESTORM TICK */}else if(e.type==='sharpenRenewal'){const amount=Math.round(this.maxHp*.03),actual=Math.min(this.maxHp-this.hp,amount);if(actual>0){this.hp+=actual;this.stats.healing+=actual;this.stats.healingByAbility['Sharpen Blade']=(this.stats.healingByAbility['Sharpen Blade']||0)+actual;this.stats.healingByTarget[this.name]=(this.stats.healingByTarget[this.name]||0)+actual;this.game.float(this,actual,'heal');this.game.vfxBurst(this,0xd83b77,.48);}e.ticks=(e.ticks||1)-1;if(e.ticks<=0)e.time=0;}else if(e.type==='slicingWinds'){const target=e.target,slash=Number(e.slashIndex||0);if(target?.alive&&dist(this,target)<=7&&this.game.arena.los(this,target)){this.game.animateAction(this,{type:'mortalSwing',school:'physical'});if(this.combatAnim)this.combatAnim.direction=slash%2?-1:1;this.game.damage(this,target,e.value||42,'Slicing Winds');this.game.vfxSlicingWinds(this,target,slash);this.game.audio.playSample('fast_swing',{gain:.42,rate:1.08+slash*.08,cooldown:0,source:this});}e.slashIndex=slash+1;e.ticks=(e.ticks||1)-1;if(e.ticks<=0)e.time=0;}else if(e.type==='hot')this.game.heal(e.source,this,e.value,e.label||'Healing over Time');else if(e.type==='iceBlock')this.game.heal(this,this,e.value,'Ice Block');else if(e.type==='agony'){this.game.damage(e.source,this,e.value*(e.stacks||1),'Creeping Torment');e.stacks=Math.min(4,(e.stacks||1)+1);}else if(e.type==='unstableAffliction'){this.game.damage(e.source,this,e.value*(e.stacks||1),'Unstable Affliction');}else if(e.type==='livingBomb'){this.game.damage(e.source,this,e.value,'Living Bomb');}else if(e.type==='flameShock'){this.game.damage(e.source,this,e.value,'Flame Shock');}else if(e.type==='cauterizeDoom'){this.hp=Math.min(this.hp,Math.max(1,this.maxHp*(e.time/5)*.30));}else{const labels={burn:'Burn',poison:'Poison',trail:'Ember Trail',soulScar:'Soul Scar',bleed:'Rend'};const periodicValue=e.type==='poison'&&this.has('shivPoisonAmp')?e.value*1.30:e.value;this.game.damage(e.source,this,periodicValue,(e.label||labels[e.type]||e.type)+' Tick');}}}if(e.time<=0&&e.type==='shield')this.shield=0;if(e.time<=0&&e.type==='livingBomb'&&this.alive){this.game.damage(e.source,this,e.explodeValue||180,'Living Bomb Explosion');this.game.vfxNova(this,COLORS.fire,2.1,18);this.game.float(this,'LIVING BOMB EXPLODES','error');}if(e.time<=0&&e.type==='bestowFaith'&&this.alive&&e.source?.alive){this.game.heal(e.source,this,e.value||240,'Bestow Faith');this.game.vfxNova(this,COLORS.holy,1.7,14);this.game.vfxGlyph(this,COLORS.holy,.82);this.game.float(this,'BESTOW FAITH','heal');}if(e.time<=0&&e.type==='touchOfDeath'&&this.alive&&e.source?.alive){const burst=Math.max(0,Math.round((e.accumulated||0)*.20));if(burst>0){this.game.damage(e.source,this,burst,'Touch of Death');this.game.vfxNova(this,0xd46cff,2.2,18);this.game.vfxGlyph(this,0xffd36b,.9);this.game.float(this,`TOUCH OF DEATH ${burst}`,'error');}}if(e.time<=0&&e.type==='cauterizeDoom'&&this.alive){this.hp=0;this.die(e.source||null);}return e.time>0;});
  if(this.cast){this.cast.left-=dt;if(this.game.netGuest||(this.game.netSession&&this.game.netSession.role==='guest')){if(this.cast.left<=0)this.cast=null;}else{if(this.cast.channel){this.cast.tick-=dt;if(this.cast.tick<=0){this.cast.tick+=this.cast.interval;this.game.channelTick(this,this.cast);}}if(this.cast.left<=0){const c=this.cast;this.cast=null;this.game.completeCast(this,c);}}}
  const smoke=this.has('defensive');const meleeBase=5.15,isCaster=['flame','storm','soul'].includes(this.cls),isHealer=['sage','pala','disc'].includes(this.cls);this.moveSpeed=isCaster?meleeBase*1.15:isHealer?meleeBase*1.05:meleeBase;if(smoke&&this.cls==='shadow')this.moveSpeed=6.75;if(this.mounted)this.moveSpeed*=1.42;if(this.has('tigersLust'))this.moveSpeed*=Number(this.has('tigersLust').speed||1.70);if(this.has('freedom'))this.moveSpeed*=Number(this.has('freedom').speed||1.30);if(this.has('divineSteed'))this.moveSpeed=(meleeBase*1.05)*1.65;if(this.has('discFade'))this.moveSpeed*=Number(this.has('discFade').speed||1.25);if(this.has('angelicBody'))this.moveSpeed*=Number(this.has('angelicBody').speed||1.30);if(this.has('cauterizeDoom'))this.moveSpeed*=1.50;if(this.modelGroup)this.modelGroup.scale.setScalar(this.has('avatar')?1.24:1);
  const poly=!!this.has('poly');
  const frameDistance=Math.hypot(this.x-this.lastX,this.z-this.lastZ);
  const immobilised=poly||this.has('sleep')||this.has('gouge')||this.has('blind')||this.has('windIncap')||this.has('fear')||this.has('iceBlock')||this.has('stun')||this.has('cheapStun')||this.has('furyStun')||this.has('root')||!!(this.cast&&!this.cast.moveCast);
  const moving=frameDistance>.002&&!immobilised;
  if(this.isPlayer)this.game.audio?.updateFootsteps(this,moving,frameDistance);
  this.motion+=( (moving?1:0)-this.motion )*Math.min(1,dt*13);
  this.walkPhase+=dt*(this.cls==='shadow'?10.4:this.cls==='wind'?10.0:8.8)*Math.max(.18,this.motion);
  const swing=Math.sin(this.walkPhase)*.72*this.motion;
  const bob=Math.abs(Math.sin(this.walkPhase))*0.045*this.motion;
  this.legL.rotation.x=swing;this.legR.rotation.x=-swing;
  this.armL.rotation.x=-swing*.72;this.armR.rotation.x=swing*.72;
  this.armL.rotation.z=.18;this.armR.rotation.z=-.18;
  this.handL.position.set(-.54,.77+bob*.35,0);this.handR.position.set(.54,.77+bob*.35,0);
  this.torso.position.y=1.18+bob;this.pelvis.position.y=.55+bob*.45;
  this.torso.rotation.x=this.motion*.055;this.torso.rotation.z=0;
  const activeCast=this.cast&&this.cast.special!=='mount'&&!poly;
  this.castOrb.visible=!!activeCast;
  if(activeCast){
    const pulse=.88+Math.sin(this.game.time*13)*.18;
    this.castOrb.scale.setScalar(pulse);this.castOrb.rotation.y+=dt*8;
    if(activeCast.a&&activeCast.a.name==='Fists of Fury'){
      this.castOrb.visible=false;const punch=Math.sin(this.game.time*34);
      this.armL.rotation.x=-1.05+punch*.65;this.armR.rotation.x=-1.05-punch*.65;
      this.handL.position.set(-.46,1.02,-.38-punch*.29);this.handR.position.set(.46,1.02,-.38+punch*.29);
      this.torso.rotation.x=-.16;
    }else{
      const ritual=Math.sin(this.game.time*9)*.10;
      this.armL.rotation.x=-1.18+ritual;this.armR.rotation.x=-1.18-ritual;
      this.armL.rotation.z=.46;this.armR.rotation.z=-.46;
      this.handL.position.set(-.40,1.27,-.28);this.handR.position.set(.40,1.27,-.28);
      this.castOrb.position.set(0,1.30,-.44);this.torso.rotation.x=-.09;
    }
  }
  if(this.combatAnim&&this.combatAnim.until>this.game.time&&!activeCast){
    const progress=1-(this.combatAnim.until-this.game.time)/this.combatAnim.dur;
    const strike=Math.sin(Math.min(1,progress)*Math.PI);
    if(this.combatAnim.type==='melee'){
      const left=Number(this.combatAnim.direction||1)<0,arm=left?this.armL:this.armR,hand=left?this.handL:this.handR,side=left?-1:1;
      arm.rotation.x=-1.75*strike;arm.rotation.z=side*(-.18-.35*strike);
      hand.position.set(side*.47,1.05,-.62*strike);this.torso.rotation.z=-side*.10*strike;
    }else{
      this.armL.rotation.x=-1.18*strike;this.armR.rotation.x=-1.18*strike;
      this.handL.position.set(-.39,1.2,-.34*strike);this.handR.position.set(.39,1.2,-.34*strike);
      this.castOrb.visible=true;this.castOrb.position.set(0,1.25,-.38-.36*strike);this.castOrb.scale.setScalar(.7+strike*.8);
    }
  }else if(!activeCast){this.castOrb.visible=false;}
  const divineSteed=!!this.has('divineSteed');
  this.mountVisual.visible=(this.mounted||divineSteed)&&!poly;
  // Preserve the imported model's calibrated foot offset when unmounted. The old
  // zero assignment discarded footY every frame and made several outfits hover.
  if(this.modelGroup)this.modelGroup.position.y=this.mountVisual.visible?(this.mountData?.riderY||.9):(this.rig?.footY||0);
  if(this.mountVisual.visible){const mountSwing=Math.sin(this.walkPhase)*.34*Math.max(.25,this.motion);this.mountVisual.position.y=.02+Math.abs(Math.sin(this.walkPhase))*0.045;this.mountLegs.forEach((leg,i)=>leg.rotation.x=(i%2?1:-1)*mountSwing);if(this.mountHeadPivot)this.mountHeadPivot.rotation.x=Math.sin(this.walkPhase*.5)*.04;if(this.mountAura)this.mountAura.rotation.z+=.012;if(this.mountVisual.userData.tickFX)this.mountVisual.userData.tickFX(this.game.time,dt);}
  if(this.palaWings){
    this.palaWings.visible=!!this.has('avengingWings')&&!poly;
    if(this.palaWings.visible){
      const wingTime=performance.now()*.004;
      const flap=.34+Math.sin(wingTime)*.2;
      const leftWing=this.palaWings.children[0],rightWing=this.palaWings.children[1];
      leftWing.rotation.y=-.38-flap;rightWing.rotation.y=.38+flap;
      leftWing.rotation.z=.06;rightWing.rotation.z=-.06;
      this.palaWings.children.forEach((wing,wi)=>wing.children.forEach((f,fi)=>{if(f.material&&f.material.opacity!==undefined)f.material.opacity=.82+.15*Math.sin(wingTime*1.4+fi+wi);}));
    }
  }
  if(this.discWings){
    const arch=!!this.has('archangel'),darkArch=!!this.has('darkArchangel');
    this.discWings.visible=(arch||darkArch)&&!poly;
    if(this.discWings.visible){
      const wt=performance.now()*.0048,flap=.16+Math.sin(wt)*.12,colour=darkArch?0x9c52ff:0xffffff;
      this.discWings.children.forEach((wing,wi)=>{wing.rotation.y=(wi?1:-1)*(.16+flap);wing.children.forEach((f,fi)=>{if(f.material){f.material.color.setHex(colour);f.material.opacity=.68+.22*Math.sin(wt*1.4+fi);}});});
    }
  }
  if(this.divineSteedMount){
    // The legacy miniature Paladin horse is incompatible with the new mount scale.
    // Divine Steed now keeps the full-sized active mount visual displayed above.
    this.divineSteedMount.visible=false;
  }
  if(this.game.target===this){this.aura.scale.setScalar(1.18);}else{this.aura.scale.setScalar(1);}
  this.polyVisual.visible=poly;
  if(this.rig){
    this.mesh.children.forEach(part=>{if(this._keepVisible&&this._keepVisible.has(part))return;part.visible=false;});
    if(this.modelGroup)this.modelGroup.visible=!poly;
  } else {
    this.mesh.children.forEach(part=>{if(part!==this.polyVisual&&part!==this.aura&&part!==this.selectRing&&part!==this.targetBeacon&&part!==this.mountVisual&&part!==this.castOrb&&part!==this.palaWings&&part!==this.divineSteedMount&&part!==this.gearAppearance)part.visible=!poly;});
  }
  if(this.gearAppearance)this.gearAppearance.visible=!poly;
  if(this.prestigeVisual){this.prestigeVisual.visible=!poly&&this.alive;if(this.prestigeVisual.userData.tick)this.prestigeVisual.userData.tick(dt);}
  if(poly){this.castOrb.visible=false;if(this.palaWings)this.palaWings.visible=false;if(this.discWings)this.discWings.visible=false;if(this.divineSteedMount)this.divineSteedMount.visible=false;this.polyVisual.rotation.y+=dt*.9;this.polyVisual.children[this.polyVisual.children.length-2].rotation.y+=dt*4;this.polyVisual.children[this.polyVisual.children.length-1].rotation.z+=dt*2.2;}
  this.mesh.scale.x=poly?1.14:1; this.mesh.scale.y=poly?1.14:1; this.mesh.scale.z=poly?1.14:1;
  this.bodyMat.emissiveIntensity=poly?.42:.24;
  let renderX=this.x,renderZ=this.z;if(this.dashTween){this.dashTween.left=Math.max(0,this.dashTween.left-dt);const p=1-this.dashTween.left/this.dashTween.total;renderX=this.dashTween.from.x+(this.dashTween.to.x-this.dashTween.from.x)*p;renderZ=this.dashTween.from.z+(this.dashTween.to.z-this.dashTween.from.z)*p;if(this.dashTween.left<=0)this.dashTween=null;}
  if(this.ai&&!this.game.netGuest){const follow=1-Math.exp(-42*dt);this.visualX+=(renderX-this.visualX)*follow;this.visualZ+=(renderZ-this.visualZ)*follow;}else{this.visualX=renderX;this.visualZ=renderZ;}if(this.isPlayer&&((this.jumpY||0)>0||(this.jumpVel||0)!==0)){this.jumpVel-=15.5*dt;this.jumpY=Math.max(0,(this.jumpY||0)+this.jumpVel*dt);if(this.jumpY<=0){this.jumpY=0;this.jumpVel=0;}}this.mesh.position.set(this.visualX,this.jumpY||0,this.visualZ);const actionFacing=!!(this.cast&&this.cast.target)||(this.combatAnim&&this.combatAnim.until>this.game.time);const face=(this.cast&&this.cast.target)||(this.game.target===this.game.player?null:this.game.target);if(this.isPlayer&&!poly&&!actionFacing){const y=this.game.cameraRig.facingYaw??this.game.cameraRig.yaw;this.mesh.rotation.y=Math.atan2(-Math.sin(y),-Math.cos(y));}else if(face&&face!==this&&face.alive&&!poly)this.mesh.rotation.y=Math.atan2(face.x-this.x,face.z-this.z);if(this.has('bladestorm'))this.mesh.rotation.y+=dt*17;const targeted=this.game.target===this;this.selectRing.visible=targeted;if(targeted){this.selectRing.rotation.z+=dt*2.8;this.selectRing.material.opacity=.82+.18*Math.sin(this.game.time*7);}if(this.targetBeacon){this.targetBeacon.visible=false;this.targetBeacon.rotation.y+=dt*2.2;this.targetBeacon.children.forEach((c,i)=>{if(c.material)c.material.opacity=.48+.24*Math.sin(this.game.time*5+i);});}this.aura.material.opacity=this.alive?.86:.12;
  if(this.rig){
    const fury=activeCast&&activeCast.a&&activeCast.a.name==='Fists of Fury';
    const st={motion:this.motion,phase:this.walkPhase,time:this.game.time,spell:false,castFury:false,melee:null,meleeStrike:0,mounted:!!(this.mounted||this.has('divineSteed'))};
    if(!poly){
      if(activeCast){ if(fury)st.castFury=true; else st.spell=true; }
      else if(this.combatAnim&&this.combatAnim.until>this.game.time){
        const progress=1-(this.combatAnim.until-this.game.time)/this.combatAnim.dur;
        const strike=Math.sin(Math.min(1,progress)*Math.PI);
        if(this.combatAnim.type==='melee'){ st.melee=progress; st.meleeStrike=strike; st.meleeSide=Number(this.combatAnim.direction||1); } else { st.spell=true; }
      }
      const tier=this.game.performanceTier||0,poseDivisor=tier>=2?(this.isPlayer?2:3):(tier===1&&!this.isPlayer?2:1),poseOffset=this.isPlayer?0:Math.max(0,this.game.units.indexOf(this));
      if(((this.game.visualFrame||0)+poseOffset)%poseDivisor===0)AetherKit.pose(this.rig,st,dt*poseDivisor);
    }
  }
  this.lastX=this.x;this.lastZ=this.z;
 }
 takeDamage(source,amount,label){if(!this.alive)return;if(this.has('iceBlock')){this.game.float(this,'IMMUNE','info');return;}if(this.has('cloakShadows')){const physical=this.game.isMeleeStrike(label)||/bladestorm|fists of fury|pummel|charge|mortal swing|night slash|viper cut|garrote|ribbreaker|zephyr palm|cloudstep|rising sun kick/i.test(String(label||''));if(this.game.isPeriodicDamageLabel(label)||!physical){this.game.float(this,'CLOAK IMMUNE','info');return;}}const intercept=this.has('interceptGuard');if(intercept&&intercept.source&&intercept.source!==this&&intercept.source.alive&&!String(label||'').includes('(Intercepted)')){this.game.float(this,'INTERCEPTED','info');this.game.vfxGlyph(this,COLORS.warrior,.46);intercept.source.takeDamage(source,amount,`${label||'Damage'} (Intercepted)`);return;}const sac=this.has('sacrifice');if(sac&&sac.source&&sac.source!==this&&sac.source.alive){this.game.float(this,'PROTECTED','info');this.game.vfxGlyph(this,COLORS.holy,.46);sac.source.takeDamage(source,amount,label);return;} if(this.has('poly')&&BALANCE.polyBreaksOnDamage){this.game.breakControl(this,'poly','POLYMORPH BROKEN');} if(this.has('sleep')){this.game.breakControl(this,'sleep','SLUMBER BROKEN');} if(this.has('gouge')){this.game.breakControl(this,'gouge','GOUGE BROKEN');} if(this.has('blind')){this.game.breakControl(this,'blind','BLIND BROKEN');} if(this.has('fear')){const fe=this.has('fear');if(fe.breakFromDots!==false||!this.game.isPeriodicDamageLabel(label))this.game.breakControl(this,'fear','FEAR BROKEN');} if(this.has('windIncap')){this.game.breakControl(this,'windIncap','INCAPACITATE BROKEN');} const guard=this.has('defensive'); if(guard)amount*=1-(guard.reduction||.35);const mendGuard=this.has('shadowMendGuard');if(mendGuard)amount*=1-(mendGuard.reduction||.10);const staticGuard=this.has('staticAegisGuard');if(staticGuard)amount*=1-(staticGuard.reduction||.20);if(this.gearStats)amount*=1-Math.min(.08,(this.gearStats.Versatility||0)*.00018);let absorbed=0;if(this.shield>0){absorbed=Math.min(this.shield,amount);this.shield-=absorbed;amount-=absorbed;if(source)source.stats.damage+=0;this.game.float(this,Math.round(absorbed),'info','ABSORB');const ma=this.has('moltenArmor');if(ma&&source&&source!==this&&source.alive){source.takeDamage(this,Math.max(8,Math.round(absorbed*.12)),'Fire Shield');source.effect('burn',3,{value:5,source:this});this.game.vfxBurst(source,COLORS.fire,.45);}}if(this.has('touchKarma')&&source&&source!==this&&source.alive&&amount>0){source.takeDamage(this,Math.round(amount*.70),'Touch of Karma');this.game.float(source,'KARMA REFLECT','error');amount*=.80;} amount=Math.round(amount);if(this.trainingDummy){const floor=Math.ceil(this.maxHp*.80);amount=Math.min(amount,Math.max(0,this.hp-floor));if(this.hp<=floor+.5)this.dummyRegen=true;}if(amount>0){this.game.audio.playImpact(label,source,this);this.hp-=amount;if(this.has&&this.has('touchKarma')&&source&&source!==this&&source.alive){
 const karma=this.has('touchKarma');
 const reflected=Math.max(1,amount*Number(karma.reflectPct||.5));
 source.effect('karmaDot',4,{value:reflected/4,source:this,label:'Karma'});
 this.game.float(source,'KARMA DOT','error');
 this.game.vfxGlyph(source,COLORS.wind,.45);
 /* KARMA REFLECT DOT */
}if(this.has&&this.has('moltenArmor')&&source&&source!==this&&source.alive){
 const ma=this.has('moltenArmor');
 const retaliate=Number(ma.value||14);
 source.effect('burn',3,{value:retaliate/3,source:this,label:'Fire Shield Burn'});
 source.hp=Math.max(0,source.hp-retaliate);
 this.game.float(source,'FIRE SHIELD BURN','error');
 this.game.vfxBurst(source,COLORS.fire,.42);
 if(source.hp<=0)this.game.kill(source,this);
}if(source){const ability=label||'Damage';source.stats.damage+=amount;source.stats.damageByAbility[ability]=(source.stats.damageByAbility[ability]||0)+amount;source.stats.damageByTarget[this.name]=(source.stats.damageByTarget[this.name]||0)+amount;}this.game.float(this,amount,'damage');this.game.flash(this.mesh,0xff4c48);}
  if(this.hp<=0){if(this.cls==='flame'&&talentRank(this.cls,'flame_cauterize')>0&&!this.has('cauterizeUsed')){this.hp=Math.round(this.maxHp*.30);this.effect('cauterizeUsed',9999);this.effect('cauterizeDoom',5,{source});this.game.vfxNova(this,COLORS.fire,2.4,20);this.game.vfxOrbit(this,COLORS.fire,1.5);this.game.float(this,'CAUTERIZE · 5s','error');this.game.audio.play('fire');}else this.die(source);}}
 receiveHeal(source,amount,label='Healing'){if(!this.alive)return;if(this.has('smokeBomb')&&source&&source!==this){this.game.float(this,'HEAL BLOCKED','error');return;}if(this.has('sharpenedWound'))amount*=.60;amount*=1-this.game.dampening;const actual=Math.min(this.maxHp-this.hp,Math.round(amount));if(actual<=0)return;this.hp+=actual;if(source){const ability=label||'Healing';source.stats.healing+=actual;source.stats.healingByAbility[ability]=(source.stats.healingByAbility[ability]||0)+actual;source.stats.healingByTarget[this.name]=(source.stats.healingByTarget[this.name]||0)+actual;}this.game.float(this,actual,'heal');this.game.vfxBurst(this,0x63f5b0,.7);}
 fallToGround(){if(this.castOrb)this.castOrb.visible=false;if(this.palaWings)this.palaWings.visible=false;if(this.discWings)this.discWings.visible=false;if(this.divineSteedMount)this.divineSteedMount.visible=false;if(this.aura)this.aura.visible=false;if(this.selectRing)this.selectRing.visible=false;if(this.targetBeacon)this.targetBeacon.visible=false;const side=this.team==='ally'?-1:1;if(this.modelGroup){this.modelGroup.position.y=.18;this.modelGroup.rotation.x=.10;this.modelGroup.rotation.z=side*Math.PI*.5;}else{this.mesh.position.y=.18;this.mesh.rotation.z=side*Math.PI*.5;}}
 die(killer){this.game.audio.play('death',this);this.alive=false;this.hp=0;this.cast=null;this.mounted=false;if(this.mountVisual)this.mountVisual.visible=false;if(this.gearAppearance)this.gearAppearance.visible=false;if(this.prestigeVisual)this.prestigeVisual.visible=false;this.fallToGround();if(killer){killer.stats.kb++;}/* Death now applies one lightweight fallen-body pose instead of leaving the character standing or traversing the full model tree. */this.game.float(this,'DEFEATED','error');this.game.log(`${this.name} was defeated.`);if(this.game.target===this)this.game.target=null;}
 destroy(){this.game.clearTotemMasteryVisuals?.(this);this.game.clearCombustionVisuals?.(this);this.game.scene.remove(this.mesh);this.plate.remove();}
}
const aetherBaseTakeDamage=Character.prototype.takeDamage;
Character.prototype.takeDamage=function(source,amount,label){
 if(this.has('guardianImmunity')){this.game?.float?.(this,'GUARDIAN ANGEL · IMMUNE','info');return;}
 const shieldBefore=Number(this.shield||0),hpBefore=Number(this.hp||0);
 const karma=this.has('touchKarma'),karmaIndex=karma?this.effects.indexOf(karma):-1;
 if(karmaIndex>=0)this.effects.splice(karmaIndex,1);
 let adjusted=Number(amount)||0;
 if(this.cls==='warrior'&&this.hp/this.maxHp<.45)adjusted*=1-unitTalentRank(this,'battlehardened')*.03;
 if(this.has('holdTheLine'))adjusted*=1-Number(this.has('holdTheLine').reduction||0);
 if(this.has('temperedFocus'))adjusted*=1-Number(this.has('temperedFocus').reduction||0);
 if(this.cls==='wind'&&(this.has('defensive')||this.has('touchKarma')))adjusted*=1-unitTalentRank(this,'wind_temple_guard')*.03;
 if(this.cls==='storm'&&this.cast&&unitTalentRank(this,'grounded')>0&&Math.random()<.08*unitTalentRank(this,'grounded')){this.game?.gainMana?.(this,2);this.game?.float?.(this,'GROUNDED CASTING · +2 MANA','heal');}
 const result=aetherBaseTakeDamage.call(this,source,adjusted,label);
 if(karma&&karma.time>0&&this.alive)this.effects.splice(Math.min(Math.max(0,karmaIndex),this.effects.length),0,karma);
 const shieldLost=Math.max(0,shieldBefore-Number(this.shield||0)),hpLost=Math.max(0,hpBefore-Number(this.hp||0));
 if(karma&&hpLost>0&&source&&source!==this&&source.alive&&!/Touch of Karma/i.test(String(label||''))){
  const reflected=Math.max(1,Math.round(hpLost*.30)),restored=Math.min(this.maxHp-this.hp,Math.max(1,Math.round(hpLost*.50)));
  source.takeDamage(this,reflected,'Touch of Karma');
  if(restored>0){this.hp+=restored;this.stats.healing+=restored;this.stats.healingByAbility['Touch of Karma']=(this.stats.healingByAbility['Touch of Karma']||0)+restored;this.stats.healingByTarget[this.name]=(this.stats.healingByTarget[this.name]||0)+restored;this.game?.float?.(this,restored,'heal');}
  this.game?.float?.(source,`KARMA ${reflected}`,'error');this.game?.vfxGlyph?.(source,COLORS.wind,.45);
 }
 if(shieldLost>0)this.game?.audio?.playSample('shield_block',{source:this});
 if(this.isPlayer&&hpLost>0)this.game?.audio?.playHurt(hpLost,this.maxHp);
 return result;
};
class AIController {
 constructor(game,unit){
  this.game=game;this.u=unit;this.wait=Math.random()*.35;this.reactiveWait=Math.random()*.08;this.focus=null;this.nextFocusAt=0;this.healFocus=null;this.healFocusUntil=0;this.trinketDecision=null;this.dispelDecision=null;this.reactiveHealth=new Map();
  this.moveIntent=null;this.route=null;this.stuckTime=0;this.lastMoveX=unit.x;this.lastMoveZ=unit.z;this.openerHold=2.2+Math.random()*1.8;this.discKitePlan=null;
 }
 ratingProfile(base){
  const playerClass=this.game.player?.cls||this.u.cls,mode=bracketKey(this.game.mode||'2v2');
  const rating=this.game.queueType==='ranked'?classRating(playerClass,mode):1600;
  const tier=rating>=2700?4:rating>=2400?3:rating>=2000?2:rating>=1800?1:0;
  const cadence=[1.18,1,.86,.72,.62][tier],bonus=[0,.05,.13,.20,.25][tier];
  return {...base,rating,tier,min:Math.max(.08,base.min*cadence),max:Math.max(.16,base.max*cadence),interrupt:clamp(base.interrupt+bonus,.1,.97),kite:clamp(base.kite+bonus*.8,.1,.94)};
 }
 update(dt){
  const u=this.u;if(!u.alive||this.game.phase!=='fight'||this.game.paused)return;
  this.tickMovement(dt);
  const d=this.ratingProfile(DIFFICULTY[this.game.difficulty]);
  this.reactiveWait-=dt;
  if(this.reactiveWait<=0){
   this.reactiveWait=[.16,.12,.085,.06,.045][d.tier]||.16;
   const reactiveAllies=this.game.units.filter(x=>x.team===u.team&&x.alive);
   const reactiveEnemies=this.game.units.filter(x=>x.team!==u.team&&x.alive&&!isUntargetableStealth(x,u));
   const hardLocked=['furyStun','cheapStun','stun','poly','sleep','blind','windIncap','fear','iceBlock'].some(type=>u.has(type));
   if(!hardLocked){
    if((u.cls==='sage'||u.cls==='pala'||u.cls==='disc')&&this.antiMageHealerResponse(reactiveAllies,reactiveEnemies))return;if((u.cls==='sage'||u.cls==='pala'||u.cls==='disc')&&this.reactiveHealerEmergency(reactiveAllies,reactiveEnemies,d))return;
    if(u.cls!=='sage'&&u.cls!=='pala'&&u.cls!=='disc'&&this.reactiveDpsEmergency(reactiveAllies,reactiveEnemies,d))return;
   }
  }
  this.wait-=dt;if(this.wait>0)return;
  this.wait=d.min+Math.random()*(d.max-d.min);
  const cc=this.game.breakableControl(u);
  if(cc){
   if(this.game.tryBotControlledDefensive(u,cc)){this.trinketDecision=null;this.stopMove();return;}
   if(this.game.shouldBotTrinket(u,cc,d)){
    const delay=this.game.botTrinketDelay(u,cc,d);
    if(!this.trinketDecision||this.trinketDecision.type!==cc.type){this.trinketDecision={type:cc.type,until:this.game.time+delay};}
    if(this.game.time>=this.trinketDecision.until){this.game.useTrinket(u,true);this.trinketDecision=null;this.stopMove();return;}
   }else this.trinketDecision=null;
   if(cc.type!=='root'){this.stopMove();return;}
  }else this.trinketDecision=null;
  const emergencyDefensiveUsed=this.game.tryBotEmergencyDefensive?.(u);if(emergencyDefensiveUsed&&['sage','pala','disc'].includes(u.cls)){this.stopMove();return;}
  if(u.cast&&u.cast.moveCast){
   const alliesForCast=this.game.units.filter(x=>x.team===u.team&&x.alive);
   const enemiesForCast=this.game.units.filter(x=>x.team!==u.team&&x.alive&&!isUntargetableStealth(x,u));
   if(u.cls==='sage'&&enemiesForCast.length){
    const lowCast=alliesForCast.slice().sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0]||u;
    const threat=enemiesForCast.slice().sort((a,b)=>dist(a,u)-dist(b,u))[0];
    const point=threat?this.pillarKitePoint(threat,lowCast):null;
    if(point&&dist(u,point)>1.0)this.moveToPoint(point.x,point.z,.40);
    else if(threat&&dist(u,threat)<18)this.moveToward(threat,true);
   }else if(u.cls==='wind'&&u.cast.a?.type==='fistsChannel'&&enemiesForCast.length){
    const t=(this.focus&&this.focus.alive&&!isUntargetableStealth(this.focus,u))?this.focus:(this.coordinatedTarget(enemiesForCast)||this.chooseEnemy(enemiesForCast));
    if(t){if((t.has('iceBlock')||isUntargetableStealth(t,u))&&u.cast.left<1.9){u.cast=null;if(u.fistsFx)u.fistsFx.dead=true;u.fistsFx=null;return;}if(dist(u,t)>8.5&&u.cast.left<1.45){u.cast=null;if(u.fistsFx)u.fistsFx.dead=true;u.fistsFx=null;return;}
     if(dist(u,t)>3.4)this.moveToward(t,false);
     else if(dist(u,t)<1.4)this.moveToward(t,true);
     else this.stopMove(false);
    }
   }else if(u.cls==='warrior'&&u.cast.bladestorm&&enemiesForCast.length){
    const t=(this.focus&&this.focus.alive&&!isUntargetableStealth(this.focus,u))?this.focus:(this.coordinatedTarget(enemiesForCast)||this.chooseEnemy(enemiesForCast));
    if(t){if(dist(u,t)>3.3)this.moveToward(t,false);else if(dist(u,t)<1.2)this.moveToward(t,true);else this.stopMove(false);}
   }else if(u.cls==='disc'&&u.cast.discPenance){
    const t=u.cast.target;
    const lowCast=alliesForCast.slice().sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0]||u;
    const pressure=enemiesForCast.filter(e=>this.attacking(u,e)||(e.cast&&e.cast.target===u)||(['shadow','wind','warrior'].includes(e.cls)&&dist(e,u)<7)).sort((a,b)=>dist(a,u)-dist(b,u))[0];
    const shouldKite=!!pressure&&(u.hp/u.maxHp<.90||this.enemyBurstPotential(u,enemiesForCast)>=1.4||dist(pressure,u)<7);
    const point=shouldKite?this.disciplineKitePoint(pressure,lowCast):null;
    if(point&&dist(u,point)>1.0)this.moveToPoint(point.x,point.z,.55);
    else if(t&&t.alive){if(t.team===u.team&&dist(u,t)>20)this.moveToward(t,false);else if(t.team!==u.team&&dist(u,t)>21)this.moveToward(t,false);}
   }
   return;
  }
  const allies=this.game.units.filter(x=>x.team===u.team&&x.alive);
  const enemies=this.game.units.filter(x=>x.team!==u.team&&x.alive&&!isUntargetableStealth(x,u));
  if(!enemies.length){if(u.cls==='sage'||u.cls==='pala'||u.cls==='disc')this.healer(allies,[],d);return;}
  if(u.cls==='sage'||u.cls==='pala'||u.cls==='disc'){
   if(this.spreadPreventiveHealing(allies,enemies,d))return;
   this.healer(allies,enemies,d);
  }else this.dps(allies,enemies,d);
 }
 healthDropRate(unit){
  if(!unit||!unit.alive)return 0;
  const now=this.game.time,hp=unit.hp/unit.maxHp,prev=this.reactiveHealth.get(unit);
  let rate=0;
  if(prev&&now>prev.time+.015)rate=Math.max(0,(prev.hp-hp)/(now-prev.time));
  this.reactiveHealth.set(unit,{hp,time:now});
  return rate;
 }
 readyAbilityIndex(unit,names){
  const arr=AB[unit?.cls]||[];
  for(const name of names){
   const i=arr.findIndex(a=>a.name===name||a.type===name);
   if(i<0)continue;
   const a=arr[i];
   const reactiveOffGcd=['natureSwiftness','iceBlock','paladinSteed','painSuppression','tigereyeBrew','pummel','reflect','warriorGuard','avatar'].includes(a.type)||['Counterflare','Wind Shear','Combustion','Living Bomb'].includes(a.name);
   const cancellingControl=!!(unit.cast&&['sleep','poly','fear','blind','windIncap','root','stun','singleStun'].includes(unit.cast.a?.type));
   if(unit.cds[i]<=0&&unit.resource>=(a.cost||0)&&(unit.gcd<=.05||reactiveOffGcd||cancellingControl))return i;
  }
  return -1;
 }
 enemyBurstPotential(target,enemies=[]){
  if(!target||!target.alive)return 0;
  let score=0;
  for(const e of enemies){
   if(!e.alive)continue;
   const d=dist(e,target),los=this.game.arena.los(e,target);
   const focusing=this.attacking(target,e)||(e.cast&&e.cast.target===target)||(e===this.game.player&&this.game.target===target);
   if(focusing)score+=.75;
   if(e.cast&&e.cast.target===target){score+=e.cast.left<.55?1.65:1.05;if(e.cast.channel)score+=.55;}
   if(!los&&d>8)continue;
   if(e.has('combustion'))score+=2.35;
   if(e.has('stormkeeper'))score+=2.15;
   if(e.has('tempestBolts'))score+=1.45;
   if(e.has('overload'))score+=.85;
   if(e.has('instantBolt'))score+=1.25+Math.min(.65,(e.has('instantBolt').stacks||1)*.18);
   if(e.has('meteorLance'))score+=1.20;
   if(e.has('avatar'))score+=2.10;
   if(e.has('warbreakerReady'))score+=1.25;
   if(e.has('empoweredSwing'))score+=1.10;
   if(e.has('gushingWoundReady'))score+=.75;
   if(e.has('tigereye')||e.has('tigereyeBrew'))score+=2.10;if(e.has('risingSunReady'))score+=1.25;
   if(e.has('tempestFlow'))score+=.65;if(e.has('volcanicEruptionReady'))score+=1.45;
   if(e.has('smokePower')||e.has('eviscerateReady')||e.has('venomEdge'))score+=1.05;
   const vend=target.has('vendetta');if(vend&&vend.source===e)score+=2.15;
   if(target.has('smokeBomb'))score+=1.75;
   if(target.has('livingBomb'))score+=.55;if(target.has('flameShock'))score+=.25;if(target.has('shivPoisonAmp'))score+=.40;
   if(target.has('bleed'))score+=.30;
   if(target.has('unstableAffliction'))score+=.40;
   const majorReady={flame:['Combustion','Living Bomb'],storm:['Stormkeeper','Skybreaker Pulse','Volcanic Eruption'],warrior:['Avatar','Warbreaker'],wind:['Tigereye Brew','Strike of the Windlord','Fists of Fury','Rising Sun Kick'],shadow:['Vendetta','Garrote'],soul:['Pandemic Bloom','Mortal Horror']}[e.cls]||[];
   if(focusing&&majorReady.some(name=>this.readyAbilityIndex(e,[name])>=0))score+=.65;
  }
  return score;
 }
 reactiveCastCancelNeeded(target,drop,burst){
  const u=this.u;if(!u.cast||u.cast.channel)return false;
  const hp=target.hp/target.maxHp;
  const castTarget=u.cast.target;
  const castType=u.cast.a?.type;
  const controlCast=['sleep','poly','fear','blind','windIncap','root','stun','singleStun'].includes(castType);
  // Crowd control is optional pressure. If an ally becomes unsafe, abandon the setup immediately.
  if(controlCast)return hp<.76||drop>.08||burst>=2.0||target.has('smokeBomb');
  const almostFinished=u.cast.left<=.18;
  const sameUsefulTarget=castTarget===target&&['heal','holyLight','bigHeal','discMend'].includes(castType);
  if(almostFinished&&sameUsefulTarget&&hp>.36&&drop<.20&&burst<4.5)return false;
  return hp<.48||drop>.16&&hp<.78||burst>=3.8&&hp<.68;
 }
 useReactiveAbility(index,target,label){
  const u=this.u;if(index<0)return false;
  const requested=AB[u.cls]?.[index];
  // The emergency evaluator runs several times during a cast. Keep an
  // already-useful cast committed instead of cancelling and restarting the
  // exact same spell on the exact same ally (the Shadow Mend loop).
  if(u.cast&&u.cast.target===target&&requested&&u.cast.a?.type===requested.type&&(requested.cast||0)>0)return true;
  if(u.cast){
   const wasControl=['sleep','poly','fear','blind','windIncap','root','stun','singleStun'].includes(u.cast.a?.type);
   u.cast=null;
   if(wasControl)u.gcd=0; // allow the emergency heal immediately after abandoning optional CC.
   this.game.float(u,wasControl?'CC CANCELLED · SAVE ALLY':'CAST CANCELLED · EMERGENCY','info');
  }
  const used=this.game.tryAbility(u,index,target,false);
  if(used&&label)this.game.log(`${u.name} reacts instantly with ${label}.`);
  return !!used;
 }
 hasNamedHot(target,name,minTime=0){
  return !!target?.effects?.some(effect=>effect.type==='hot'&&effect.label===name&&effect.source===this.u&&effect.time>minTime);
 }
 reactiveHealerEmergency(allies,enemies,d){
  const u=this.u;if(!allies.length)return false;
  const evaluated=allies.map(a=>{const hp=a.hp/a.maxHp,drop=this.healthDropRate(a),burst=this.enemyBurstPotential(a,enemies);const score=(1-hp)*5.4+Math.min(3.2,drop*8.5)+burst*.58+(a.has('smokeBomb')?1.8:0);return {a,hp,drop,burst,score};}).sort((x,y)=>y.score-x.score);
  const state=evaluated[0],target=state?.a;if(!target)return false;
  const controlCast=!!(u.cast&&['sleep','poly','fear','blind','windIncap','root','stun','singleStun'].includes(u.cast.a?.type));
  const controlEmergency=controlCast&&(state.hp<.76||state.burst>=2.0||state.drop>.08||target.has('smokeBomb'));
  const emergency=state.hp<.48||(state.hp<.70&&state.burst>=2.5)||(state.hp<.80&&state.drop>.15)||(target.has('smokeBomb')&&state.hp<.78)||controlEmergency;
  if(!emergency)return false;
  const inLine=dist(u,target)<=28&&this.game.arena.los(u,target);
  if(!inLine){
   if(u.cast&&(state.hp<.55||controlEmergency)){if(controlCast)u.gcd=0;u.cast=null;this.game.float(u,'CC CANCELLED · RESTORE HEALING LOS','info');}
   return this.moveToHealLine(target,enemies,true);
  }
  const canCancel=this.reactiveCastCancelNeeded(target,state.drop,state.burst);
  if(u.cast&&!canCancel)return false;
  const ready=names=>this.readyAbilityIndex(u,names);
  const use=(names,t=target,label=names[0])=>this.useReactiveAbility(ready(names),t,label);
  if(u.cls==='disc'){
   const pain=this.readyAbilityIndex(u,['Pain Suppression']);
   if(pain>=0&&state.hp<.70&&state.burst>=2.0&&!target.has('painSuppression'))return this.useReactiveAbility(pain,target,'PAIN SUPPRESSION');
   const radiance=this.readyAbilityIndex(u,['Ultimate Radiance']);
   if(radiance>=0&&(state.hp<.40||evaluated.filter(x=>x.hp<.58).length>=2))return this.useReactiveAbility(radiance,u,'ULTIMATE RADIANCE');
   const shield=this.readyAbilityIndex(u,['Power Shield']);
   if(shield>=0&&state.hp<.72&&!target.has('shield'))return this.useReactiveAbility(shield,target,'POWER SHIELD');
   const mend=this.readyAbilityIndex(u,['Shadow Mend']);
   const holyLocked=!!u.has('lock_holy');
   // Shadow Mend is the emergency shadow-school escape hatch, not the normal
   // rotation. Atonement damage remains the preferred recovery plan.
   if(mend>=0&&(state.hp<.42||(holyLocked&&state.hp<.56)||(state.hp<.50&&state.burst>=3.4)))return this.useReactiveAbility(mend,target,'SHADOW MEND · LAST RESORT');
  }
  if(u.cls==='pala'){
   const selfHp=u.hp/u.maxHp;
   const sac=ready(['Blessing of Sacrifice']);
   const guardian=ready(['Guardian Angel']);
   const toll=ready(['Divine Toll']);
   const word=ready(['Word of Glory']);
   const shock=ready(['Holy Shock']);
   const faith=ready(['Bestow Faith']);
   const severe=state.hp<.42||state.drop>.22||state.burst>=4.5;
   if(target!==u&&sac>=0&&!target.has('sacrifice')&&state.hp<.76&&(state.burst>=2.6||state.drop>.12)){
    if(selfHp<.62){const guard=ready(['Divine Protection']);if(guard>=0)this.useReactiveAbility(guard,u,'Divine Protection');}
    if(this.useReactiveAbility(sac,target,'Blessing of Sacrifice'))return true;
   }
   if(severe&&guardian>=0&&this.useReactiveAbility(guardian,target,'Guardian Angel'))return true;
   if((state.hp<.60||state.drop>.17||state.burst>=4.0)&&toll>=0&&this.useReactiveAbility(toll,target,'Divine Toll'))return true;
   if(state.hp<.66&&word>=0&&this.useReactiveAbility(word,target,'Word of Glory'))return true;
   if(state.hp<.78&&shock>=0&&this.useReactiveAbility(shock,target,'Holy Shock'))return true;
   if(state.hp<.82&&faith>=0&&!target.has('bestowFaith')&&(state.burst>=1.6||state.drop>.07)&&this.useReactiveAbility(faith,target,'Bestow Faith'))return true;
  }else if(u.cls==='sage'){
   const iron=ready(['Ironbark']);
   const tide=ready(['Renewal Tide']);
   const swift=ready(['Nature Swiftness']);
   const blossom=ready(['Spirit Blossom']);
   const rejuv=ready(['Rejuvenate']);
   const echo=ready(['Blooming Echo']);const ghanir=ready(["G'Hanir, the Mother Tree"]);
   const severe=state.hp<.42||state.drop>.22||state.burst>=4.5;
   if(ghanir>=0&&!u.has('ghanir')&&(target.has('hot')||allies.some(a=>a.has('hot')))&&state.hp<.86&&(state.burst>=2.0||state.drop>.08)&&this.useReactiveAbility(ghanir,u,"G'Hanir"))return true;
   if(iron>=0&&!target.has('defensive')&&state.hp<.80&&(state.burst>=2.4||state.drop>.11)&&this.useReactiveAbility(iron,target,'Ironbark'))return true;
   if((state.hp<.60||state.drop>.16||state.burst>=4.0)&&tide>=0&&this.useReactiveAbility(tide,target,'Renewal Tide'))return true;
   const tideIndex=(AB[u.cls]||[]).findIndex(a=>a.name==='Renewal Tide');
   if(tideIndex>=0&&u.cds[tideIndex]>1&&swift>=0&&(state.hp<.66||severe)&&this.useReactiveAbility(swift,u,'Nature Swiftness'))return true;
   const injured=allies.filter(a=>a.hp/a.maxHp<.64).length;
   if(injured>=2&&blossom>=0&&this.useReactiveAbility(blossom,target,'Spirit Blossom'))return true;
   if(state.hp<.76){
    const hasRejuvenate=target.effects.some(effect=>effect.type==='hot'&&effect.label==='Rejuvenate');
    const hasBloomingEcho=target.effects.some(effect=>effect.type==='hot'&&effect.label==='Blooming Echo');
    if(rejuv>=0&&!hasRejuvenate&&this.useReactiveAbility(rejuv,target,'Rejuvenate'))return true;
    if(echo>=0&&!hasBloomingEcho&&this.useReactiveAbility(echo,target,'Blooming Echo'))return true;
   }
  }
  return false;
 }
 reactiveDpsEmergency(allies,enemies,d){
  const u=this.u,hp=u.hp/u.maxHp,drop=this.healthDropRate(u),burst=this.enemyBurstPotential(u,enemies);
  const lethal=hp<.42||(hp<.62&&drop>.22)||(hp<.66&&burst>=4.8);
  if(!lethal)return false;
  // High-frequency defensive reaction only. Positioning and counter-pressure remain in the normal decision loop.
  return !!this.game.tryBotEmergencyDefensive?.(u);
 }
 stopMove(clearRoute=true){this.moveIntent=null;if(clearRoute){this.route=null;this.stuckTime=0;}}
 moveToward(target,away=false){
  if(!target||!target.alive)return;
  const changed=!this.moveIntent||this.moveIntent.target!==target||this.moveIntent.away!==away;
  if(changed){this.route=null;this.stuckTime=0;}
  this.moveIntent={target,away,until:this.game.time+1.45};
 }
 moveToPoint(x,z,hold=1.15){
  const target={x:clamp(x,-BALANCE.arenaX+1.2,BALANCE.arenaX-1.2),z:clamp(z,-BALANCE.arenaZ+1.2,BALANCE.arenaZ-1.2),alive:true,aiPoint:true};
  const changed=!this.moveIntent||!this.moveIntent.target?.aiPoint||Math.hypot(this.moveIntent.target.x-target.x,this.moveIntent.target.z-target.z)>.85||this.moveIntent.away;
  if(changed){this.route=null;this.stuckTime=0;}
  this.moveIntent={target,away:false,until:this.game.time+hold};
 }
 pillarKitePoint(threat,healTarget=null){
  const u=this.u,pillars=this.game.arena.pillars||[];if(!threat||!pillars.length)return null;
  const hostiles=this.game.units.filter(e=>e.team!==u.team&&e.alive&&!isUntargetableStealth(e,u));
  const ordered=[threat,...hostiles.filter(e=>e!==threat)].filter(Boolean);
  let best=null,bestScore=-999,bestFullyHidden=null,bestFullyHiddenScore=-999;
  for(const p of pillars){
   for(const extra of [2.25,2.85,3.45,4.05]){
    const radius=p.r+extra;
    for(let i=0;i<28;i++){
     const a=i*Math.PI*2/28;
     const point={x:clamp(p.x+Math.cos(a)*radius,-BALANCE.arenaX+1.4,BALANCE.arenaX-1.4),z:clamp(p.z+Math.sin(a)*radius,-BALANCE.arenaZ+1.4,BALANCE.arenaZ-1.4),alive:true,aiPoint:true};
     const primaryBlocked=!!this.game.arena.blockingPillar(threat,point);
     const visible=ordered.filter(e=>this.game.arena.los(e,point));
     const blockedCount=ordered.length-visible.length;
     const activeVisible=visible.filter(e=>(e===this.game.player&&this.game.target===u)||(e.ai&&e.ai.focus===u)||(e.cast&&e.cast.target===u)||dist(e,point)<10).length;
     const selfDist=Math.hypot(u.x-point.x,u.z-point.z);
     const nearestThreat=ordered.length?Math.min(...ordered.map(e=>Math.hypot(point.x-e.x,point.z-e.z))):12;
     const healOk=!healTarget||healTarget===u||dist(point,healTarget)<=28;
     const healLos=!healTarget||healTarget===u||this.game.arena.los(point,healTarget);
     if(!healOk||!healLos)continue;
     const edgePenalty=(Math.abs(point.x)>BALANCE.arenaX-3||Math.abs(point.z)>BALANCE.arenaZ-3)?2.6:0;
     let score=(primaryBlocked?11:-8)+blockedCount*4.4-visible.length*2.6-activeVisible*4.2+Math.min(8,nearestThreat*.28)-selfDist*.16-edgePenalty;
     if(healTarget&&healTarget!==u)score+=2.0;
     if(score>bestScore){bestScore=score;best=point;}
     if(primaryBlocked&&activeVisible===0&&score>bestFullyHiddenScore){bestFullyHiddenScore=score;bestFullyHidden=point;}
    }
   }
  }
  return bestFullyHidden||best;
 }
 healLinePoint(healTarget,enemies=[]){
  const u=this.u;if(!healTarget||!healTarget.alive)return null;
  const threats=(enemies||[]).filter(e=>e.alive).sort((a,b)=>dist(a,healTarget)-dist(b,healTarget));
  const primary=threats[0]||null;
  const candidates=[];
  const add=(x,z)=>candidates.push({x:clamp(x,-BALANCE.arenaX+1.3,BALANCE.arenaX-1.3),z:clamp(z,-BALANCE.arenaZ+1.3,BALANCE.arenaZ-1.3),alive:true,aiPoint:true});
  add(u.x,u.z);
  add(healTarget.x,healTarget.z);
  for(const r of [4.2,7.5,11.5,15.5]){
   for(let i=0;i<16;i++){
    const a=i*Math.PI*2/16;
    add(healTarget.x+Math.cos(a)*r,healTarget.z+Math.sin(a)*r);
   }
  }
  let best=null,bestScore=-999;
  for(const p of candidates){
   const healDist=Math.hypot(p.x-healTarget.x,p.z-healTarget.z);
   if(healDist>28||!this.game.arena.los(p,healTarget))continue;
   const selfDist=Math.hypot(p.x-u.x,p.z-u.z);
   const nearestThreat=threats.length?Math.min(...threats.map(e=>Math.hypot(p.x-e.x,p.z-e.z))):12;
   const blocksThreat=primary&&this.game.arena.blockingPillar(primary,p)?1:0;
   const stillPlayable=Math.abs(p.x)<BALANCE.arenaX-2&&Math.abs(p.z)<BALANCE.arenaZ-2;
   let score=10-selfDist*.24+Math.min(8,nearestThreat*.34)+blocksThreat*2.2+(stillPlayable?1.2:-3);
   if(primary&&this.game.arena.los(primary,p)&&nearestThreat<12)score-=1.8;
   if(healDist<6)score-=1.0; // avoid standing directly on top of the partner unless needed
   if(score>bestScore){bestScore=score;best=p;}
  }
  return best;
 }
 moveToHealLine(healTarget,enemies=[],urgent=false){
  const u=this.u;if(!healTarget||!healTarget.alive||healTarget===u)return false;
  const hp=healTarget.hp/healTarget.maxHp;
  const needs=urgent||hp<.84||healTarget.has('smokeBomb')||this.game.unitUnderMajorOffensive?.(healTarget)||this.game.unitUnderBurst?.(healTarget);
  const inLine=dist(u,healTarget)<=28&&this.game.arena.los(u,healTarget);
  if(inLine||!needs)return false;
  if(u.cast&&(hp<.72||urgent))u.cast=null;
  if(u.cls==='pala'&&u.cds[6]<=0&&!u.has('divineSteed')&&dist(u,healTarget)>13)this.game.tryAbility(u,6,u);
  const p=this.healLinePoint(healTarget,enemies);
  if(p){this.moveToPoint(p.x,p.z,urgent?1.0:.75);return true;}
  this.moveToward(healTarget,false);return true;
 }
 healUrgency(unit,enemies=[]){
  if(!unit?.alive)return -999;
  const hp=unit.hp/unit.maxHp;
  const attackers=enemies.filter(e=>e.alive&&((e.cast&&e.cast.target===unit)||this.attacking(unit,e)||(e===this.game.player&&this.game.target===unit)));
  const hardControl=['poly','sleep','blind','windIncap','fear','furyStun','cheapStun','stun'].some(type=>unit.has(type));
  return (1-hp)*7.2+this.enemyBurstPotential(unit,enemies)*.62+attackers.length*.82+(unit.has('smokeBomb')?2.2:0)+(hardControl?0.55:0)+(unit===this.u&&attackers.length?0.25:0);
 }
 chooseHealTarget(allies,enemies=[]){
  const available=allies.filter(a=>a.alive&&!a.has('smokeBomb'));
  const pool=available.length?available:allies.filter(a=>a.alive);
  const ranked=pool.slice().sort((a,b)=>this.healUrgency(b,enemies)-this.healUrgency(a,enemies));
  const best=ranked[0]||this.u,current=pool.find(a=>a===this.healFocus);
  const bestScore=this.healUrgency(best,enemies),currentScore=current?this.healUrgency(current,enemies):-999;
  // Hold a triage target briefly so the healer can complete a coherent plan.
  // A genuinely more urgent ally still breaks the lock immediately.
  if(current&&this.game.time<this.healFocusUntil&&current.hp/current.maxHp<.94&&bestScore<currentScore+1.15)return current;
  if(best!==this.healFocus){this.healFocus=best;this.healFocusUntil=this.game.time+.75;}
  return best;
 }
 spreadPreventiveHealing(allies,enemies,d){
  const u=this.u;if(d.tier<1||u.cast||u.gcd>.05)return false;
  const injured=allies.filter(a=>a.alive&&!a.has('smokeBomb')&&a.hp/a.maxHp<.90).sort((a,b)=>this.healUrgency(b,enemies)-this.healUrgency(a,enemies));
  if(injured.length<2||injured.some(a=>a.hp/a.maxHp<.54))return false;
  const usable=target=>dist(u,target)<=28&&this.game.arena.los(u,target);
  const use=(name,target)=>{const i=AB[u.cls].findIndex(a=>a.name===name);if(i<0||u.cds[i]>0||u.resource<(AB[u.cls][i].cost||0)||!usable(target))return false;return this.game.tryAbility(u,i,target,false)===true;};
  if(u.cls==='sage'){
   for(const target of injured){if(!this.hasNamedHot(target,'Rejuvenate',2.5)&&use('Rejuvenate',target))return true;}
   for(const target of injured){if(!this.hasNamedHot(target,'Blooming Echo',2.5)&&use('Blooming Echo',target))return true;}
  }
  if(u.cls==='disc'){
   for(const target of injured){const atoned=target.effects.some(e=>e.type==='atonement'&&e.source===u&&e.time>3);if(!atoned&&!target.has('shield')&&use('Power Shield',target))return true;}
  }
  if(u.cls==='pala'){
   for(const target of injured){if(!target.has('bestowFaith')&&use('Bestow Faith',target))return true;}
  }
  return false;
 }
 setTeamRegroup(anchor,critical,threat,reason='split-pressure'){
  if(!anchor)return null;
  this.game.aiRegroupPlans=this.game.aiRegroupPlans||{};
  const plan={anchor:{x:anchor.x,z:anchor.z,alive:true,aiPoint:true},critical,threat,reason,until:this.game.time+2.2};
  this.game.aiRegroupPlans[this.u.team]=plan;
  return plan;
 }
 teamRegroupPlan(allies,enemies){
  this.game.aiRegroupPlans=this.game.aiRegroupPlans||{};
  const current=this.game.aiRegroupPlans[this.u.team];
  if(current&&current.until>this.game.time&&current.critical?.alive)return current;
  const healer=allies.find(a=>a.alive&&['sage','pala','disc'].includes(a.cls));
  if(!healer)return null;
  const ranked=allies.filter(a=>a.alive).map(a=>({a,score:this.healUrgency(a,enemies),hp:a.hp/a.maxHp})).sort((x,y)=>y.score-x.score);
  const critical=ranked[0]?.a||healer;
  const injured=ranked.filter(x=>x.hp<.78).length;
  const split=injured>=2||critical!==healer&&(dist(healer,critical)>24||!this.game.arena.los(healer,critical));
  const pressured=enemies.filter(e=>e.alive&&((e.cast&&e.cast.target===healer)||this.attacking(healer,e)||(e===this.game.player&&this.game.target===healer))).sort((a,b)=>dist(a,healer)-dist(b,healer));
  const threat=pressured[0]||enemies.filter(e=>e.alive).sort((a,b)=>dist(a,critical)-dist(b,critical))[0];
  if(!threat||(!split&&pressured.length===0)||this.u!==healer)return null;
  const anchor=this.pillarKitePoint(threat,critical)||this.healLinePoint(critical,enemies);
  return anchor?this.setTeamRegroup(anchor,critical,threat,split?'split-pressure':'healer-swap'):null;
 }
 tryTeamPeel(allies,enemies,d){
  const u=this.u;
  // Preserve Soulweaver's successful v223 rotation and decision tree exactly.
  if(u.cls==='soul'||d.tier<1)return false;
  const healer=allies.find(a=>a!==u&&a.alive&&['sage','pala','disc'].includes(a.cls));
  if(!healer)return false;
  const attackers=enemies.filter(e=>e.alive&&((e.cast&&e.cast.target===healer)||this.attacking(healer,e)||(e===this.game.player&&this.game.target===healer))).sort((a,b)=>dist(a,healer)-dist(b,healer));
  const threat=attackers[0],healerHp=healer.hp/healer.maxHp;
  const separated=dist(u,healer)>24||!this.game.arena.los(u,healer);
  if(!threat||healerHp>.78&&!separated)return false;
  const kill=this.focus&&this.focus.alive&&this.focus.hp/this.focus.maxHp<.30&&!this.game.botCanSelfSaveSoon?.(this.focus);
  if(kill)return false;
  const controls={flame:['Prism Hex','Frostfire Nova'],warrior:['Stormbolt','Intimidating Shout'],wind:['Incapacitate','Valley Sweep'],shadow:['Blind','Ribbreaker'],storm:['Static Snare']}[u.cls]||[];
  for(const name of controls){
   const i=AB[u.cls].findIndex(a=>a.name===name);if(i<0||u.cds[i]>0||u.resource<(AB[u.cls][i].cost||0))continue;
   const a=AB[u.cls][i],selfCast=['Intimidating Shout','Valley Sweep'].includes(name),max=selfCast?(a.range||8):(a.range||22);
   if(dist(u,threat)>max+.5||!this.game.arena.los(u,threat)||this.ccValue(threat,a.type||'stun')<=0)continue;
   if(this.game.tryAbility(u,i,selfCast?u:threat,false)){this.focus=threat;this.nextFocusAt=this.game.time+1.1;return true;}
  }
  const plan=this.game.aiRegroupPlans?.[u.team];
  if(separated&&plan&&plan.until>this.game.time&&plan.anchor&&dist(u,plan.anchor)>6&&healerHp<.62){this.moveToPoint(plan.anchor.x,plan.anchor.z,.72);return true;}
  return false;
 }
 selfSaveAbility(names,target=null){
  const u=this.u;target=target||u;
  for(const name of names){
   const i=AB[u.cls].findIndex(a=>a.name===name||a.type===name);
   if(i>=0&&u.cds[i]<=0&&u.resource>=(AB[u.cls][i].cost||0)){
    if(this.game.tryAbility(u,i,target))return true;
   }
  }
  return false;
 }
 counterPressureTarget(enemies){
  const u=this.u;
  const viable=enemies.filter(e=>e.alive&&!isUntargetableStealth(e,u)&&!this.hasSetupCC(e)&&this.game.arena.los(u,e));
  if(!viable.length)return null;
  const hs=this.enemyHealerState(viable);
  const scored=viable.map(e=>{
   const hp=e.hp/e.maxHp,defDown=!this.game.botCanSelfSaveSoon?.(e),trinketDown=e.trinketCd>0,major=this.game.unitUnderMajorOffensive?.(e)||e.has('smokeBomb');
   let score=(1-hp)*5+(defDown?1.0:0)+(trinketDown?1.0:0)+(major?1.25:0);
   if(hs.locked&&!['sage','pala','disc'].includes(e.cls))score+=1.55;
   if(hs.exposed&&!['sage','pala','disc'].includes(e.cls))score+=.75;
   if(['sage','pala','disc'].includes(e.cls)&&!e.cast&&hp>.62&&!major)score-=1.35;
   if(dist(u,e)>22)score-=1.25;
   return {e,score};
  }).sort((a,b)=>b.score-a.score);
  return scored[0]?.score>=2.6?scored[0].e:null;
 }
 shouldCounterPressure(allies,enemies,primary,hp,realMajor,healerLocked,healerCanHelp){
  const u=this.u,target=this.counterPressureTarget(enemies);
  if(!target)return false;
  const thp=target.hp/target.maxHp;
  const teamBehind=allies.some(a=>a.alive&&a.hp/a.maxHp<.58)||healerLocked||!healerCanHelp||realMajor;
  const killWindow=thp<.52||target.trinketCd>0&&!this.game.botCanSelfSaveSoon?.(target)||this.game.unitUnderMajorOffensive?.(target)||target.has('smokeBomb')||this.enemyHealerState(enemies).locked;
  if(!teamBehind||!killWindow)return false;
  if(hp<.44)return false; // too low: survive first
  // If the bot can trade a defensive/offensive and keep swinging, it should not run immediately.
  if(primary&&dist(primary,u)<7&&hp<.68){
   if(u.cls==='wind')this.selfSaveAbility(['Touch of Karma','Willow Guard','monkDefensive']);
   if(u.cls==='warrior')this.selfSaveAbility(['Shield Wall','warriorGuard']);
   if(u.cls==='shadow')this.selfSaveAbility(['Evasion','Cloak of Shadows','Crimson Vial']);
   if(u.cls==='flame')this.selfSaveAbility(['Fire Shield','Molten Armor','Alter Time']);
   if(u.cls==='storm')this.selfSaveAbility(['Static Aegis','Grounding Aegis']);
   if(u.cls==='soul')this.selfSaveAbility(['Undying Resolve','Dark Pact']);
  }
  this.focus=target;
  this.nextFocusAt=this.game.time+2.2;
  return true;
 }
 kitePressure(target){
  const u=this.u;
  if(!target?.alive||u.cast||u.gcd>0||!this.game.arena.los(u,target))return false;
  const pressureNames={warrior:['Mortal Swing','Rend'],shadow:['Night Slash','Viper Cut'],wind:['Zephyr Palm','Cloudstep Kick'],storm:['Frost Shock']}[u.cls]||[];
  for(const name of pressureNames){
   const index=AB[u.cls].findIndex(a=>a.name===name),a=index>=0?AB[u.cls][index]:null;
   if(!a||u.cds[index]>0||u.resource<(a.cost||0)||dist(u,target)>(a.range||0)+.35)continue;
   if(this.game.tryAbility(u,index,target,false)===true)return true;
  }
  return false;
 }
 dpsSurvivalResponse(allies,enemies,d){
  const u=this.u;if(['sage','pala','disc'].includes(u.cls)||!enemies.length)return false;
  const healer=allies.find(a=>a!==u&&a.alive&&['sage','pala','disc'].includes(a.cls));
  const hp=u.hp/u.maxHp;

  const activeAttackers=enemies.filter(e=>{
   if(!e.alive)return false;
   const isMelee=['shadow','wind','warrior'].includes(e.cls);
   const activelyCasting=e.cast&&e.cast.target===u;
   const connectedMelee=isMelee&&dist(e,u)<5.8&&this.game.arena.los(e,u);
   const realFocus=e.ai&&e.ai.focus===u&&(connectedMelee||activelyCasting||dist(e,u)<8.5);
   const playerRealPressure=e===this.game.player&&this.game.target===u&&!['sage','pala','disc'].includes(e.cls)&&((isMelee&&dist(e,u)<6)||activelyCasting);
   return activelyCasting||connectedMelee||realFocus||playerRealPressure;
  });

  const primary=activeAttackers.sort((a,b)=>dist(a,u)-dist(b,u))[0]||enemies.slice().sort((a,b)=>dist(a,u)-dist(b,u))[0];
  const healerLocked=!!(healer&&this.hasSetupCC(healer));
  const healerCanHelp=!!(healer&&dist(healer,u)<=28&&this.game.arena.los(healer,u)&&!healerLocked);
  const realMajor=!!(this.game.unitUnderMajorOffensive?.(u)||u.has('smokeBomb'));
  const incomingCast=activeAttackers.some(e=>e.cast&&e.cast.target===u);
  const realSwap=activeAttackers.length>=2||(activeAttackers.length>=1&&(hp<.60||realMajor||healerLocked&&hp<.70));

  // Important tuning:
  // A single caster hitting a DPS is not enough reason to abandon pressure.
  // DPS only disengage when the situation is actually lethal or the healer cannot help.
  const danger=hp<.46||realMajor&&hp<.76||realSwap||healerLocked&&hp<.62;

  if(!danger){
   // If taking some pressure but not lethal, use a light/self-sustain button without giving up uptime.
   if(incomingCast&&hp<.78){
    if(u.cls==='wind')this.selfSaveAbility(['Willow Guard','monkDefensive']);
    if(u.cls==='warrior'){const vr=AB[u.cls].findIndex(a=>a.name==='Victory Rush');if(vr>=0&&u.cds[vr]<=0&&primary&&dist(u,primary)<=4.8&&this.game.arena.los(u,primary)&&hp<.76)this.game.tryAbility(u,vr,primary);}
    if(u.cls==='shadow'&&hp<.70)this.selfSaveAbility(['Crimson Vial']);
   }
   return false;
  }

  if(this.shouldCounterPressure(allies,enemies,primary,hp,realMajor,healerLocked,healerCanHelp)){
   // We are behind, but the enemy also has a killable target. Trade cooldowns and play to win instead of panic-kiting.
   return false;
  }

  if(!this.game.majorDefensiveActive?.(u)){
   if(u.cls==='flame'&&(hp<.42||realMajor&&hp<.58))this.selfSaveAbility(['Ice Block']);
   if(u.cls==='shadow'){if(hp<.56)this.selfSaveAbility(['Crimson Vial']);if(hp<.60||realMajor&&hp<.72)this.selfSaveAbility(['Evasion','Cloak of Shadows','Smoke Veil']);}
   if(u.cls==='wind'){if(hp<.58||realMajor&&hp<.72)this.selfSaveAbility(['Touch of Karma','Willow Guard','monkDefensive']);if((u.has('root')||u.has('slow'))&&primary)this.selfSaveAbility(["Tiger's Lust"]);}
   if(u.cls==='warrior'){if(hp<.58||realMajor&&hp<.70)this.selfSaveAbility(['Shield Wall','warriorGuard']);const vr=AB[u.cls].findIndex(a=>a.name==='Victory Rush');if(vr>=0&&u.cds[vr]<=0&&primary&&dist(u,primary)<=4.8&&this.game.arena.los(u,primary)&&hp<.72)this.game.tryAbility(u,vr,primary);}
   if(u.cls==='storm'&&(hp<.58||realMajor&&hp<.70))this.selfSaveAbility(['Static Aegis','Grounding Aegis']);
   if(u.cls==='soul'&&(hp<.62||realMajor&&hp<.74))this.selfSaveAbility(['Undying Resolve','Dark Pact']);
  }

  // Move to healer LoS only when actually unsafe, not simply because the line is imperfect.
  if(healer&&!healerLocked&&!healerCanHelp&&(hp<.64||realMajor||activeAttackers.length>=2)){
   const p=this.healLinePoint(u,[primary].filter(Boolean));
   if(p&&dist(u,p)>.95){this.setTeamRegroup(p,u,primary,'dps-needs-healer-line');this.moveToPoint(p.x,p.z,.70);this.kitePressure(primary);return true;}
   this.moveToward(healer,false);this.kitePressure(primary);return true;
  }

  // Hard kite only during genuine kill pressure.
  if(primary&&(healerLocked&&hp<.68||realMajor||hp<.52||activeAttackers.length>=2&&hp<.72)){
   const p=this.pillarKitePoint(primary,healer&&!healerLocked?healer:null);
   if(p&&dist(u,p)>.95){this.setTeamRegroup(p,u,primary,'dps-hard-kite');this.moveToPoint(p.x,p.z,.75);this.kitePressure(primary);return true;}
   if(dist(primary,u)<7.2){this.moveToward(primary,true);this.kitePressure(primary);return true;}
  }

  return false;
 }
 openerHealerSetup(allies,enemies,low){
  const u=this.u;
  if(this.game.time>11||!low||!enemies?.length)return false;
  if(allies.some(a=>!a.alive||a.hp/a.maxHp<.93||this.hasSetupCC(a)))return false;
  if(u.cast)return false;
  const enemy=enemies.filter(e=>e.alive).sort((a,b)=>dist(a,low)-dist(b,low))[0]||enemies[0];
  if(!enemy)return false;
  const point=this.pillarKitePoint(enemy,low);
  if(point&&dist(u,point)>1.15){
   this.moveToPoint(point.x,point.z,.95);
   return true;
  }
  return false;
 }
 disciplineKitePoint(threat,healTarget){
  if(!threat)return null;
  const cached=this.discKitePlan;
  if(cached&&cached.threat===threat&&cached.healTarget===healTarget&&this.game.time<cached.until)return cached.point;
  const point=this.pillarKitePoint(threat,healTarget);
  this.discKitePlan={threat,healTarget,point,until:this.game.time+.65};
  return point;
 }
 disciplineDamageTarget(allies,enemies){
  const u=this.u,accessible=enemies.filter(e=>e.alive&&!isUntargetableStealth(e,u)&&dist(u,e)<=25&&this.game.arena.los(u,e));
  if(!accessible.length)return null;
  const partner=allies.find(a=>a!==u&&a.alive),coordinated=this.coordinatedTarget(enemies);
  const partnerTarget=partner===this.game.player?this.game.target:partner?.ai?.focus;
  const enemyHealer=enemies.find(e=>e.alive&&['sage','pala','disc'].includes(e.cls));
  const healerControlled=!!(enemyHealer&&this.hasSetupCC(enemyHealer));
  return accessible.map(target=>{
   const hp=target.hp/target.maxHp,defended=!!(this.game.majorDefensiveActive?.(target)||target.has('iceBlock')||target.has('touchKarma')||target.has('warriorGuard'));
   let score=(1-hp)*5.2-dist(u,target)*.018;
   if(target===coordinated)score+=3.1;
   if(target===partnerTarget)score+=2.7;
   if(this.game.unitUnderMajorOffensive?.(target))score+=1.7;
   if(healerControlled&&target!==enemyHealer)score+=1.25;
   if(defended)score-=5.5;
   return {target,score};
  }).sort((a,b)=>b.score-a.score)[0]?.target||accessible[0];
 }
 disciplineTacticalPositioning(allies,enemies,low){
  const u=this.u;if(u.cls!=='disc'||!enemies.length)return false;
  // Smite and Shadow Mend are stationary casts. Never cancel or drag either of
  // them through movement; this planner runs between casts and during the
  // explicitly mobile Penance channel instead.
  if(u.cast&&!u.cast.moveCast)return false;
  const visible=enemies.filter(e=>e.alive&&this.game.arena.los(e,u)).sort((a,b)=>dist(a,u)-dist(b,u));
  const incoming=visible.find(e=>e.cast&&e.cast.target===u);
  const focused=visible.find(e=>this.attacking(u,e));
  const melee=visible.find(e=>['shadow','wind','warrior'].includes(e.cls)&&dist(e,u)<7.2);
  const threat=incoming||melee||focused||visible[0];if(!threat)return false;
  const selfHp=u.hp/u.maxHp,selfBurst=this.enemyBurstPotential(u,enemies);
  const partner=allies.find(a=>a!==u&&a.alive),spacingNeeded=!!(partner&&dist(u,partner)<8&&(!low||low.hp/low.maxHp>.58));
  const resourcePressure=u.resource<34&&!!focused;
  const pressured=!!incoming||!!melee||!!focused&&(selfHp<.94||selfBurst>=1.0)||selfHp<.80||selfBurst>=2.2||resourcePressure||spacingNeeded;
  if(!pressured)return false;
  const healAnchor=low?.alive&&low!==u?low:(partner||u);
  const point=this.disciplineKitePoint(threat,healAnchor);
  if(point&&dist(u,point)>1.05){this.moveToPoint(point.x,point.z,.95);return true;}
  if(melee&&dist(melee,u)<6.5){this.moveToward(melee,true);return true;}
  if(spacingNeeded){this.moveToward(partner,true);return true;}
  return false;
 }
 healerReposition(allies,enemies,low,opts={}){
   const u=this.u;if(!u.alive)return false;
   const threats=enemies.filter(e=>e.alive).sort((a,b)=>dist(a,u)-dist(b,u));
   const threat=opts.threat||threats[0];if(!threat)return false;
   const hp=u.hp/u.maxHp,lowHp=low?low.hp/low.maxHp:1;
   const lowNeedsHeal=low&&low.alive&&lowHp<.82&&dist(u,low)<=30&&this.game.arena.los(u,low);const lowNeedsLine=low&&low.alive&&lowHp<.86&&low!==u&&(!this.game.arena.los(u,low)||dist(u,low)>28);
   const selfNeedsHeal=hp<.72;
   const targeted=threats.some(e=>(e===this.game.player&&this.game.target===u)||(e.ai&&e.ai.focus===u));
   const partnerLocked=allies.find(a=>a!==u&&a.alive&&['poly','fear','sleep','blind','windIncap','furyStun','cheapStun','stun'].some(type=>a.has(type)));
   const casterThreat=threats.find(e=>e.cast&&e.cast.target===u&&['poly','sleep','fear'].includes(e.cast.a?.type));
   const meleeConnected=threats.some(e=>['shadow','wind','warrior'].includes(e.cls)&&dist(e,u)<5.8);
   const enemyKillable=threats.find(e=>e.hp/e.maxHp<.30&&dist(e,u)<=28&&this.game.arena.los(u,e));
   const danger=targeted||meleeConnected||casterThreat||hp<.68||(partnerLocked&&dist(threat,u)<15);
   const urgent=hp<.50||meleeConnected||casterThreat;

   const plan=this.teamRegroupPlan(allies,enemies);
   if(plan?.anchor){
    const anchorDistance=dist(u,plan.anchor),critical=plan.critical?.alive?plan.critical:low;
    const hasHealLine=critical&&dist(u,critical)<=28&&this.game.arena.los(u,critical);
    if(anchorDistance>1.15){
     if(u.cls==='pala'&&anchorDistance>8&&u.cds[6]<=0&&!u.has('divineSteed'))this.game.tryAbility(u,6,u);
     if(u.cls==='sage'&&urgent&&u.cds[5]<=0&&u.resource>=6&&!u.has('defensive'))this.game.tryAbility(u,5,u);
     this.moveToPoint(plan.anchor.x,plan.anchor.z,1.0);
     // Continue choosing instant healing while moving, but do not stand and cast into a broken line.
     if(!hasHealLine||lowHp>.76&&hp>.70)return true;
    }
   }

   // Do not let positioning override the healer's actual job.
   // If someone needs a heal and the healer can see them, normal healer logic should cast.
   if(lowNeedsHeal||selfNeedsHeal){
    if(u.cast){
     const goodHeal=u.cast.target===u||u.cast.target===low;
     if(!goodHeal&&(casterThreat||meleeConnected||targeted))u.cast=null;
    }
    // Movement defensives are allowed, but do not return true; continue into healing logic this tick.
    if(urgent&&u.cls==='sage'&&u.cds[5]<=0&&u.resource>=6&&!u.has('defensive'))this.game.tryAbility(u,5,u);
    if(urgent&&u.cls==='pala'&&u.cds[6]<=0&&!u.has('divineSteed'))this.game.tryAbility(u,6,u);
    return false;
   }

   if(!danger)return false;
   if(enemyKillable&&hp>.55&&!meleeConnected&&!casterThreat)return false;

   if(u.cast&&(urgent||dist(threat,u)<7||targeted))u.cast=null;
   const point=this.pillarKitePoint(casterThreat||threat,low);
   if(point&&(urgent||targeted||partnerLocked)){
    if(u.cls==='sage'&&urgent&&u.cds[5]<=0&&u.resource>=6&&!u.has('defensive'))this.game.tryAbility(u,5,u);
    if(u.cls==='pala'&&urgent&&u.cds[6]<=0&&!u.has('divineSteed'))this.game.tryAbility(u,6,u);
    this.moveToPoint(point.x,point.z,1.05);
    return true;
   }
   if(urgent&&dist(threat,u)<7){this.moveToward(threat,true);return true;}
   return false;
  }
 buildRoute(blocker,target,flip=false){
  const u=this.u,vx=target.x-u.x,vz=target.z-u.z,l=Math.hypot(vx,vz)||1;
  const px=-vz/l,pz=vx/l,clearance=blocker.r+1.8;
  const preferred=((this.game.units.indexOf(u)+(u.team==='ally'?0:1))%2===0?1:-1);
  let side=preferred;
  if(this.route&&this.route.blocker===blocker)side=this.route.side;
  if(flip)side=-side;
  const option=s=>({x:clamp(blocker.x+px*s*clearance,-BALANCE.arenaX+1,BALANCE.arenaX-1),z:clamp(blocker.z+pz*s*clearance,-BALANCE.arenaZ+1,BALANCE.arenaZ-1)});
  if(!this.route&&!flip){
   const a=option(1),b=option(-1);
   const score=p=>Math.hypot(p.x-u.x,p.z-u.z)+Math.hypot(target.x-p.x,target.z-p.z);
   if(Math.abs(score(a)-score(b))>.35)side=score(a)<score(b)?1:-1;
  }
  const p=option(side);
  this.route={blocker,target,side,x:p.x,z:p.z,created:this.game.time,until:this.game.time+2.8};
 }
 tickMovement(dt){
  const u=this.u,intent=this.moveIntent;
  if(!intent||!intent.target||!intent.target.alive||this.game.time>intent.until){this.stopMove();return;}
  if((u.cast&&!u.cast.moveCast)||u.has('furyStun')||u.has('cheapStun')||u.has('root')||u.has('stun')||u.has('poly')||u.has('sleep')||u.has('blind')||u.has('windIncap')||u.has('fear')||u.has('iceBlock'))return;
  const target=intent.target;
  let tx=target.x,tz=target.z;
  const currentDistance=dist(u,target);
  if(target.aiPoint&&currentDistance<1.05){this.stopMove();return;}
  if(intent.away&&currentDistance>14){this.stopMove();return;}
  const blocker=!intent.away&&!target.aiPoint&&this.game.arena.blockingPillar(u,target);
  if(!intent.away&&blocker){
   if(!this.route||this.route.blocker!==blocker||this.route.target!==target||this.game.time>this.route.until)this.buildRoute(blocker,target,false);
   tx=this.route.x;tz=this.route.z;
   if(Math.hypot(u.x-tx,u.z-tz)<.62){this.route=null;tx=target.x;tz=target.z;}
  }else if(this.route&&this.game.arena.los(u,target)){
   this.route=null;this.stuckTime=0;
  }
  let dx=tx-u.x,dz=tz-u.z,l=Math.hypot(dx,dz);
  if(l<.06){if(this.route){this.route=null;return;}this.stopMove();return;}
  dx/=l;dz/=l;if(intent.away){
   dx=-dx;dz=-dz;
   // Avoid mindless corner kiting: blend the retreat vector back toward playable space near walls.
   const margin=3.2,edgeX=BALANCE.arenaX-margin,edgeZ=BALANCE.arenaZ-margin;
   if(Math.abs(u.x)>edgeX)dx+=-Math.sign(u.x)*1.35;
   if(Math.abs(u.z)>edgeZ)dz+=-Math.sign(u.z)*1.35;
   const retreatLen=Math.hypot(dx,dz)||1;dx/=retreatLen;dz/=retreatLen;
  }
  const slow=u.has('slow')?.pct||0;
  const step=u.moveSpeed*(1-slow)*(u.cast?.moveSpeedMult||1)*dt,beforeX=u.x,beforeZ=u.z;
  u.x+=dx*step;u.z+=dz*step;
  if(!u.has('bladestorm')){const desired=Math.atan2(dx,dz);let angle=((desired-u.mesh.rotation.y+Math.PI)%(Math.PI*2))-Math.PI;u.mesh.rotation.y+=angle*Math.min(1,dt*13);}
  this.game.arena.constrain(u);
  const progress=Math.hypot(u.x-beforeX,u.z-beforeZ);
  if(blocker&&progress<Math.max(.006,step*.18))this.stuckTime+=dt;else this.stuckTime=Math.max(0,this.stuckTime-dt*2);
  if(blocker&&this.stuckTime>.32){this.buildRoute(blocker,target,true);this.stuckTime=0;}
 }
 targetDefensiveStateScore(target){
  if(!target||!target.alive)return 0;
  let score=0;
  const hp=target.hp/target.maxHp;
  if(target.trinketCd>0)score+=1.15;
  if(!this.game.botCanSelfSaveSoon?.(target))score+=1.00;
  if(this.game.majorDefensiveActive?.(target))score-=3.25;
  if(target.has('iceBlock')||target.has('evasion')||target.has('cloakShadows')||target.has('touchKarma')||target.has('warriorGuard')||target.has('undyingResolve'))score-=3.5;
  if(target.has('sacrifice')||target.has('ironbark')||target.has('shield'))score-=1.4;
  if(target.has('vendetta')||target.has('smokeBomb'))score+=1.1;
  if(hp<.72&&target.trinketCd>0)score+=.55;
  if(hp<.55)score+=.85;
  if(hp<.38)score+=1.55;
  return score;
 }
 enemyHealerState(enemies){
  const healer=enemies.find(e=>e.alive&&(e.cls==='sage'||e.cls==='pala'||e.cls==='disc'));
  if(!healer)return {healer:null,locked:true,exposed:true};
  const locked=this.hasSetupCC(healer)||!!this.game.breakableControl?.(healer);
  const exposed=locked||healer.hp/healer.maxHp<.55||healer.trinketCd>0&&!this.game.botCanSelfSaveSoon?.(healer)||this.game.unitUnderMajorOffensive?.(healer);
  return {healer,locked,exposed};
 }
 targetWinConditionScore(e,enemies){
  if(!e||!e.alive)return -999;
  const u=this.u,hp=e.hp/e.maxHp,dd=dist(u,e),los=this.game.arena.los(u,e);
  const isHealer=e.cls==='sage'||e.cls==='pala'||e.cls==='disc';
  const hs=this.enemyHealerState(enemies);
  let score=(1-hp)*5.2+this.targetDefensiveStateScore(e);
  if(e===this.game.player)score+=this.game.player&&['sage','pala','disc'].includes(this.game.player.cls)?-.10:1.10;
  if(los)score+=.50;else score-=.85;
  if(dd<8)score+=.45;else if(dd>22)score-=.65;
  if(this.hasSetupCC(e))score-=5.5; // don't tunnel protected CC unless it is a kill CC target handled elsewhere
  if(isHealer){
   // Healer pressure is valuable, but only when the healer is genuinely attackable.
   if(e.cast)score+=.90;
   if(hp<.58)score+=1.00;
   if(e.trinketCd>0&&!this.game.botCanSelfSaveSoon?.(e))score+=.80;
   if(this.game.unitUnderMajorOffensive?.(e)||e.has('smokeBomb'))score+=.95;
   if(dd>14)score-=1.10;
   if(!e.cast&&hp>.72&&!this.game.unitUnderMajorOffensive?.(e))score-=.95;
  }else{
   // DPS are often the real win condition when their healer is CC'd/exposed or their own defensive chain is gone.
   if(hs.locked)score+=1.70;
   if(hs.exposed)score+=1.00;
   if(e.trinketCd>0&&!this.game.botCanSelfSaveSoon?.(e))score+=1.65;
   if(this.game.unitUnderMajorOffensive?.(e)||e.has('smokeBomb'))score+=1.50;
   if(!this.game.botCanSelfSaveSoon?.(e))score+=.75;
   if(hp<.60&&hs.healer&&this.game.arena.los(hs.healer,e)===false)score+=.75;
  }
  if(this.focus===e)score+=.80; // maintain pressure unless a clearer win condition appears
  return score;
 }
 targetCoordinationScore(e,viable){
  let score=this.targetWinConditionScore(e,viable);
  const u=this.u,hp=e.hp/e.maxHp,isHealer=e.cls==='sage'||e.cls==='pala'||e.cls==='disc';
  const allies=this.game.units.filter(a=>a.team===u.team&&a.alive&&a!==u);
  const alliedDps=allies.filter(a=>!['sage','pala','disc'].includes(a.cls));
  const alliedFocus=alliedDps.filter(a=>a.ai&&a.ai.focus===e).length;
  if(alliedFocus)score+=alliedFocus*1.15;
  const veryLow=viable.filter(x=>x.hp/x.maxHp<.42);
  if(veryLow.length>=2){
   const lowest=veryLow.slice().sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];
   if(e===lowest)score+=1.85;
  }
  // Don't call a healer the main target unless there is a reason.
  if(isHealer&&!e.cast&&hp>.62&&!this.game.unitUnderMajorOffensive?.(e)&&!e.has('smokeBomb'))score-=1.15;
  return score;
 }
 coordinatedTarget(enemies){
  const u=this.u,viable=enemies.filter(e=>e.alive&&!isUntargetableStealth(e,u)&&!e.has('poly')&&!e.has('sleep')&&!e.has('blind')&&!e.has('furyStun'));
  if(!viable.length)return null;
  this.game.teamPlans=this.game.teamPlans||{};
  const key=u.team||'team';
  const plan=this.game.teamPlans[key];
  const validPlan=plan&&plan.target&&plan.target.alive&&viable.includes(plan.target)&&this.game.time<plan.until&&!this.game.majorDefensiveActive?.(plan.target)&&!plan.target.has('iceBlock')&&!plan.target.has('touchKarma');
  if(validPlan){
   const currentScore=this.targetCoordinationScore(plan.target,viable);
   const bestNow=viable.map(e=>({e,score:this.targetCoordinationScore(e,viable)})).sort((a,b)=>b.score-a.score)[0];
   if(!bestNow||bestNow.e===plan.target||bestNow.score<currentScore+1.15)return plan.target;
  }
  const sorted=viable.map(e=>({e,score:this.targetCoordinationScore(e,viable)})).sort((a,b)=>b.score-a.score);
  const best=sorted[0]?.e||viable[0];
  const bestScore=sorted[0]?.score||0;
  const urgency=(best.hp/best.maxHp<.45||this.game.unitUnderMajorOffensive?.(best)||best.has('smokeBomb'))?1.25:0;
  this.game.teamPlans[key]={target:best,until:this.game.time+2.4+urgency,score:bestScore};
  return best;
 }
 bestWinConditionTarget(enemies){
  const viable=enemies.filter(e=>e.alive&&!isUntargetableStealth(e,this.u)&&!e.has('poly')&&!e.has('sleep')&&!e.has('blind')&&!e.has('furyStun'));
  if(!viable.length)return null;
  return this.coordinatedTarget(viable)||viable.map(e=>({e,score:this.targetCoordinationScore(e,viable)})).sort((a,b)=>b.score-a.score)[0]?.e||viable[0];
 }
 chooseEnemy(enemies){
  const target=this.coordinatedTarget(enemies);
  if(target)return target;
  const u=this.u,viable=enemies.filter(e=>e.alive&&!isUntargetableStealth(e,u));
  if(!viable.length)return enemies[0];
  return viable.map(e=>({e,score:this.targetCoordinationScore(e,viable)})).sort((a,b)=>b.score-a.score)[0]?.e||viable[0];
 }
 hasSetupCC(target){return !!(target&&(target.has('poly')||target.has('sleep')||target.has('blind')||target.has('windIncap')||target.has('fear')||target.has('furyStun')||target.has('stun')));}
 ccValue(t,category){if(!t||!t.dr||!t.dr[category])return 1;const dr=t.dr[category];if(this.game.time>dr.until)return 1;return dr.level>=2?0:(dr.level>=1?.5:1);}
 killWindow(enemies){const viable=enemies.filter(e=>e.alive&&!isUntargetableStealth(e,this.u));const lows=viable.filter(e=>e.hp/e.maxHp<.45&&!this.game.majorDefensiveActive?.(e)&&!e.has('iceBlock'));if(lows.length>=2)return lows.sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];const hs=this.enemyHealerState(viable);const best=this.bestWinConditionTarget(viable);if(!best)return null;const hp=best.hp/best.maxHp,defDown=!this.game.botCanSelfSaveSoon?.(best),trinketDown=best.trinketCd>0,major=this.game.unitUnderMajorOffensive?.(best)||best.has('smokeBomb');if(hp<.30)return best;if(hs.locked&&hp<.60)return best;if((trinketDown||defDown)&&hp<.68&&(hs.exposed||major))return best;if((trinketDown&&defDown)&&hp<.78&&hs.locked)return best;return null;}
 interruptThreat(enemies){const map={flame:5,storm:6,shadow:6,wind:3,warrior:3};const u=this.u;return enemies.find(e=>{const i=map[e.cls];if(i===undefined||!e.alive)return false;const a=AB[e.cls]&&AB[e.cls][i];if(!a||e.cds[i]>0)return false;return dist(e,u)<=((a.range||4)+2.5)&&this.game.arena.los(e,u);});}
 attacking(victim,enemy){return !!(victim&&enemy&&((enemy===this.game.player&&this.game.target===victim)||(enemy.ai&&enemy.ai.focus===victim)));}
 peelThreat(enemies,allies,reach){
  const u=this.u,healer=allies.find(a=>a.alive&&(a.cls==='sage'||a.cls==='pala'||a.cls==='disc'));
  const victims=[u,healer].filter(Boolean),melee=e=>['shadow','wind','warrior'].includes(e.cls);
  const candidates=[];
  victims.forEach(v=>enemies.forEach(e=>{
   if(!e.alive||this.hasSetupCC(e)||!this.game.arena.los(u,e)||dist(u,e)>reach)return;
   const connected=dist(e,v)<=6.2&&(melee(e)||this.attacking(v,e));
   const pressuring=this.attacking(v,e)&&(dist(e,v)<=9.2||v.hp/v.maxHp<.72);
   if(connected||pressuring)candidates.push({target:e,score:(v===u?2.4:2.0)+(1-v.hp/v.maxHp)*3+(connected?1.1:0)-dist(u,e)*.035});
  }));
  return candidates.sort((a,b)=>b.score-a.score)[0]?.target||null;
 }
 controlPlan(enemies,primary,reach){
  const u=this.u,valid=e=>e&&e.alive&&!this.hasSetupCC(e)&&dist(u,e)<=reach&&this.game.arena.los(u,e);
  const peel=this.peelThreat(enemies,this.game.units.filter(a=>a.team===u.team&&a.alive),reach);
  if(valid(peel))return {target:peel,reason:'peel'};
  const healer=enemies.find(e=>e.alive&&(e.cls==='sage'||e.cls==='pala'||e.cls==='disc'));
  const pressure=primary&&((primary.hp/primary.maxHp)<.87||primary.has('root')||primary.has('slow')||primary.has('bleed')||primary.has('soulScar'));
  if(pressure&&healer!==primary&&valid(healer))return {target:healer,reason:'setup'};
  if(primary&&valid(primary)&&u.hp/u.maxHp<.52)return {target:primary,reason:'peel'};
  return null;
 }
 tryPlannedControl(enemies,primary,d,killMode=false){
  const u=this.u,cfg={
   flame:{i:4,r:22,cat:'incap'},shadow:{i:4,r:15,cat:'incap'},wind:{i:6,r:20,cat:'incap'},soul:{i:6,r:24,cat:'fear'},storm:{i:5,r:22,cat:'root'}
  }[u.cls];
  if(!cfg||u.cds[cfg.i]>0)return false;
  const plan=this.controlPlan(enemies,primary,cfg.r);if(!plan)return false;
  if(killMode&&plan.reason==='setup')return false;
  if(this.ccValue(plan.target,cfg.cat)<=0)return false;
  const chance=plan.reason==='peel'?.93:(.44+d.interrupt*.18);
  if(Math.random()>chance)return false;
  const used=this.game.tryAbility(u,cfg.i,plan.target)===true;if(used)this.stopMove();return used;
 }
 delayedDispel(target,index){
  if(!target||!target.alive){this.dispelDecision=null;return false;}
  const signature=target.effects.filter(e=>['poly','sleep','blind','windIncap','fear','root','slow'].includes(e.type)).map(e=>e.type).sort().join('|');
  if(!signature){this.dispelDecision=null;return false;}
  if(!this.dispelDecision||this.dispelDecision.target!==target||this.dispelDecision.index!==index||this.dispelDecision.signature!==signature){
   const hard=/poly|sleep|blind|windIncap|fear/.test(signature);const rooted=/root/.test(signature);this.dispelDecision={target,index,signature,at:this.game.time+(hard?.07:(rooted?.12:.20))+Math.random()*(hard?.07:.08)};
   return false;
  }
  if(this.game.time<this.dispelDecision.at)return false;
  this.dispelDecision=null;this.stopMove();
  return this.game.tryAbility(this.u,index,target)===true;
 }
 tryTalentToolkit(enemies){
   try{
   const u=this.u,t0=this.chooseEnemy(enemies);
   if(!t0)return false;
   const allies=this.game.units.filter(x=>x.team===u.team&&x.alive);
   const healer=allies.find(a=>a!==u&&a.alive&&(a.cls==='sage'||a.cls==='pala'||a.cls==='disc'));
   const enemyHealer=enemies.find(e=>e.alive&&(e.cls==='sage'||e.cls==='pala'||e.cls==='disc'));
   const lowest=enemies.filter(e=>e.alive).sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0]||t0;
   const killTarget=this.killWindow(enemies)||lowest||t0;
   const closeEnemies=enemies.filter(e=>e.alive&&dist(u,e)<=6.2&&this.game.arena.los(u,e));
   const beingTargeted=enemies.some(e=>e.alive&&this.attacking(u,e))||(this.game.player&&this.game.target===u);
   const meleeOnMe=enemies.some(e=>e.alive&&['shadow','wind','warrior'].includes(e.cls)&&dist(e,u)<=6.2&&this.game.arena.los(e,u));
   const casterOnMe=enemies.some(e=>e.alive&&((e.cast&&e.cast.target===u)||(this.attacking(u,e)&&!['shadow','wind','warrior'].includes(e.cls)))&&dist(e,u)<=27&&this.game.arena.los(e,u));
   const healerLocked=!!(healer&&this.hasSetupCC(healer));
   const pressureWindow=!!(killTarget&&killTarget.hp/killTarget.maxHp<.72)||!!(enemyHealer&&this.hasSetupCC(enemyHealer));
   const pickCCTarget=(range,cat='incap')=>{
    const peel=this.peelThreat(enemies,allies,range);
    if(peel&&this.ccValue(peel,cat)>0&&!this.hasSetupCC(peel))return peel;
    if(pressureWindow&&enemyHealer&&enemyHealer!==killTarget&&dist(u,enemyHealer)<=range&&this.game.arena.los(u,enemyHealer)&&this.ccValue(enemyHealer,cat)>0&&!this.hasSetupCC(enemyHealer))return enemyHealer;
    if(killTarget&&dist(u,killTarget)<=range&&this.game.arena.los(u,killTarget)&&this.ccValue(killTarget,cat)>0&&!this.hasSetupCC(killTarget))return killTarget;
    return null;
   };
   const names=[
    'Combustion','Fire Shield','Molten Armor','Alter Time','Cauterize','Dragon Breath','Living Bomb','Meteor Spear','Meteor',
    'Tigereye Brew',"Tiger's Lust",'Touch of Karma','Fists of Fury','Whirling Dragon Punch','Strike of the Windlord','Touch of Death','Disabling Reach',
    'Vendetta','Garrote','Shiv','Gouge','Sap','Crimson Vial','Evasion','Cloak of Shadows',
	    'Undying Resolve','Dark Pact','Chaos Bolt','Pandemic Bloom','Mortal Horror','Shadowfury','Summon Infernal',
    'Grounding Aegis','Totem Mastery','Stormkeeper','Volcanic Eruption','Healing Surge','Frost Shock','Healing Stream Totem','Thunderstep','Mana Well',
    'Sharpen Blade','Intercept','Warbreaker','Avatar','Stormbolt','Victory Rush','Bladestorm'
   ];
   for(const name of names){
    const i=AB[u.cls].findIndex(a=>a.name===name);
    if(i<0)continue;
    const a=AB[u.cls][i];
    if(u.cds[i]>0||u.resource<(a.cost||0))continue;
    let target=t0,self=false;
    const t=killTarget||t0,td=dist(u,t),los=this.game.arena.los(u,t),hp=u.hp/u.maxHp,thp=t.hp/t.maxHp;

    // Defensive / survival buttons should not be fired randomly on pull.
    if(['Fire Shield','Molten Armor','Alter Time'].includes(name)){
     if(!(hp<.70&&(beingTargeted||meleeOnMe||casterOnMe)))continue; self=true; target=u;
    }else if(name==='Cauterize'){
     if(!(hp<.46||healerLocked&&hp<.62))continue; self=true; target=u;
	    }else if(['Crimson Vial','Victory Rush'].includes(name)){
	     if(!(hp<.66||healerLocked&&hp<.78))continue;target=u;self=true;
    }else if(['Evasion'].includes(name)){
     if(!(meleeOnMe&&hp<.82))continue; self=true; target=u;
    }else if(['Cloak of Shadows'].includes(name)){
     if(!(casterOnMe||u.has('root')||u.has('slow')||hp<.58))continue; self=true; target=u;
    }else if(name==='Undying Resolve'){
     const major=this.game.unitUnderMajorOffensive?.(u)||false;
     const partnerCritical=allies.some(a=>a!==u&&a.alive&&(a.hp/a.maxHp<.42||a.has('smokeBomb')));
     if(!(hp<.50||major&&hp<.78||healerLocked&&hp<.72||beingTargeted&&hp<.62||partnerCritical&&hp<.72))continue;
     self=true;target=u;
    }else if(['Dark Pact','Grounding Aegis'].includes(name)){
     if(!(hp<.58||beingTargeted&&hp<.72||healerLocked&&hp<.76))continue; self=true; target=u;
    }else if(name==='Touch of Karma'){
     if(!(hp<.72&&(beingTargeted||meleeOnMe)||hp<.55))continue; self=true; target=u;
    }else if(name==="Tiger's Lust"){
     if(!(u.has('root')||u.has('slow')||td>9&&u.cds[1]>0))continue; self=true; target=u;
    }else if(name==='Bladestorm'){
     if(!(closeEnemies.length&&((pressureWindow&&thp<.85)||hp<.72||u.has('root')||u.has('slow'))))continue; self=true; target=u;
    }else if(name==='Sharpen Blade'){
     if(!(pressureWindow||thp<.78||enemyHealer&&this.hasSetupCC(enemyHealer)))continue;self=true;target=u;
    }else if(name==='Intercept'){
     const protectedAlly=allies.filter(a=>a!==u&&a.alive&&dist(u,a)<=25&&this.game.arena.los(u,a)).sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];
     if(!protectedAlly||!(protectedAlly.hp/protectedAlly.maxHp<.72&&enemies.some(e=>this.attacking(protectedAlly,e))))continue;target=protectedAlly;
    }else if(name==='Summon Infernal'){
     if(!los||td>(a.range||22)+.5||(!pressureWindow&&closeEnemies.length<2&&thp>.76))continue;target=t;
    }else if(name==='Mana Well'){
     if(!(pressureWindow||hp<.65))continue; self=true; target=u;
    }else if(name==='Avatar'){
     if(!(u.has('root')||pressureWindow||thp<.78||healerLocked&&thp<.88))continue; self=true; target=u;
    }else if(name==='Healing Surge'){
     if(killTarget&&killTarget.hp/killTarget.maxHp<.38)continue;
     const injured=this.game.units.filter(a=>a.alive&&a.team===u.team&&dist(u,a)<=28&&this.game.arena.los(u,a)).sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];
     if(!injured||injured.hp/injured.maxHp>.66)continue;target=injured;
    }else if(name==='Totem Mastery'||name==='Stormkeeper'){
     if(!(los&&td<=25&&hp>.45&&(pressureWindow||thp>.35)))continue; self=true; target=u;
    }else if(name==='Combustion'){
     if(u.has('combustion')||hp<.35||!los||td>26||thp<.28)continue; self=true; target=u;
    }else if(name==='Tigereye Brew'){
     const stacks=windTigereyeStacks(u);
     if(u.has('tigereyeBrew')||stacks<=0)continue;
     const burstReady=!!(u.has('furyReady')||u.has('tempestFlow')||AB[u.cls].some((x,idx)=>x.name==='Strike of the Windlord'&&u.cds[idx]<=0&&td<=4.4));
     if(!(stacks>=10||(stacks>=6&&(pressureWindow||burstReady||thp<.72))))continue;
     self=true;target=u;
    }else if(name==='Living Bomb'){
     if(!los||td>24||t.has('livingBomb')||t.has('poly')||t.has('sleep')||t.has('blind')||thp<.22)continue; target=t;
	    }else if(name==='Meteor Spear'||name==='Meteor'||name==='Volcanic Eruption'||name==='Pandemic Bloom'||name==='Chaos Bolt'){
     if(!los||td>(a.range||24)+.6)continue;
     if(name==='Volcanic Eruption'&&!u.has('volcanicEruptionReady'))continue;
	     if(!pressureWindow&&thp>.88&&['Meteor Spear','Meteor','Volcanic Eruption','Pandemic Bloom','Chaos Bolt'].includes(name))continue;
     target=t;
    }else if(name==='Whirling Dragon Punch'){const fistsIndex=(AB[u.cls]||[]).findIndex(spell=>spell.type==='fistsChannel');const nearby=enemies.filter(enemy=>enemy.alive&&dist(u,enemy)<=5.5&&this.game.arena.los(u,enemy));if(fistsIndex<0||u.cds[fistsIndex]<=0||!nearby.length||!u.has('tigereyeBrew'))continue;target=u;
    }else if(name==='Stormbolt'){
     const cc=pickCCTarget(a.range||22,'stun')||t;
     if(!cc||!this.game.arena.los(u,cc)||dist(u,cc)>(a.range||22)+.5||cc.has('stun')||cc.has('cheapStun')||cc.has('furyStun'))continue;
     if(!(cc.cast||pressureWindow||healerLocked||cc.hp/cc.maxHp<.72))continue;target=cc;
    }else if(name==='Warbreaker'){
     if(!los||td>4.5||t.has('poly')||t.has('sleep')||t.has('blind'))continue; target=t;
    }else if(name==='Strike of the Windlord'){
     if(!los||td>4.4||t.has('poly')||t.has('sleep')||t.has('blind'))continue;
     if(!(pressureWindow||u.has('tigereyeBrew')||thp<.88||u.cds[1]>0))continue; target=t;
    }else if(name==='Fists of Fury'){
     if(!los||td>5.2||u.cast||t.has('poly')||t.has('sleep')||t.has('blind'))continue;
     if(!(pressureWindow||u.has('tigereyeBrew')||thp<.86||closeEnemies.length>=2||hp<.72))continue; self=true; target=u;
    }else if(name==='Touch of Death'){
     if(!los||td>4.4||t.has('poly')||t.has('sleep')||t.has('blind')||t.has('touchOfDeath'))continue;
     if(windTigereyeStacks(u)<4&&!u.has('tigereyeBrew'))continue;
     if(!u.has('tigereyeBrew'))continue;target=t;
    }else if(name==='Disabling Reach'){
     if(!los||td>8.2||t.has('slow')||t.has('root')||t.has('stun')||t.has('windIncap')||u.resource<8)continue; target=t;
    }else if(name==='Shiv'){
     if(!los||td>3.8||t.has('slow')||t.has('root')||t.has('stun'))continue; target=t;
    }else if(name==='Garrote'){
     if(!los||td>4.7||t.has('bleed')||t.has('poly')||t.has('sleep')||t.has('blind'))continue; target=t;
    }else if(name==='Vendetta'){
     if(!los||td>24||t.has('vendetta')||!(pressureWindow||thp<.78))continue; target=t;
    }else if(['Gouge','Sap','Dragon Breath'].includes(name)){
     const cc=pickCCTarget(a.range||8,'incap'); if(!cc)continue; target=cc;
    }else if(name==='Mortal Horror'){
     const cc=pickCCTarget(a.range||20,'fear'); if(!cc)continue; target=cc;
    }else if(name==='Shadowfury'){
     const cc=pickCCTarget(a.range||20,'stun'); if(!cc)continue; target=cc;
    }else if(name==='Healing Stream Totem'){
     const injured=allies.some(a=>!a.healingStreamTotem&&a.hp/a.maxHp<.82);
     if(!injured&&!beingTargeted&&hp>.70)continue;self=true;target=u;
    }else if(name==='Thunderstep'){
     if(!(meleeOnMe&&hp<.76||closeEnemies.length>=2))continue; self=true; target=u;
    }else if(name==='Frost Shock'){
     if(!los||td>24||t.has('slow')||t.has('root')||td<5)continue; target=t;
    }else if(name==='Skullbreaker'){
     const caster=enemies.find(e=>e.alive&&e.cast&&!e.cast.uninterruptible&&dist(u,e)<=4.8&&this.game.arena.los(u,e));
     if(!caster)continue; target=caster;
    }
    const used=this.game.tryAbility(u,i,target,false);
    if(used===true){this.stopMove();return true;}
   }
   return false;
   }catch(err){console.warn('DPS talent toolkit scenario fallback',this.u?.cls,err);return false;}
  }
  dps(allies,enemies,d){const u=this.u;if(this.dpsSurvivalResponse(allies,enemies,d))return;const teamTarget=this.coordinatedTarget(enemies);if(teamTarget&&teamTarget.alive&&this.focus!==teamTarget&&(!this.focus||this.targetCoordinationScore(teamTarget,enemies)>this.targetCoordinationScore(this.focus,enemies)+.45)){this.focus=teamTarget;this.nextFocusAt=this.game.time+2.1;}if(!this.focus||!this.focus.alive||isUntargetableStealth(this.focus,u)||this.game.time>=this.nextFocusAt||this.focus.has('poly')||this.focus.has('sleep')||this.focus.has('blind')){this.focus=this.chooseEnemy(enemies);this.nextFocusAt=this.game.time+2.6+Math.random()*2.8;}let t=this.focus;if(!t)return;const defensiveTarget=this.game.majorDefensiveActive?.(t)||t.has('iceBlock')||t.has('touchKarma')||t.has('evasion')||t.has('warriorGuard');if(defensiveTarget){const alt=this.bestWinConditionTarget(enemies);if(alt&&alt!==t&&this.game.arena.los(u,alt)){this.focus=alt;this.nextFocusAt=this.game.time+1.2;t=alt;}}const windDashReady=u.cls==='wind'&&!u.has('cloudstepDashCd')&&u.cds[1]<=0;const range=u.cls==='shadow'?3.9:u.cls==='warrior'?4.0:(u.cls==='wind'?(windDashReady?17:4.1):22);
  if(this.tryTeamPeel(allies,enemies,d))return;
  if(!this.game.isInCombat(u)&&!u.mounted&&!u.cast&&dist(u,t)>14&&this.game.time>u.aiMountDelay){this.game.tryMount(u,false);return;}
  if(u.cls==='flame'&&u.hp/u.maxHp<.28&&u.cds[6]<=0&&!u.has('iceBlock')){this.game.tryAbility(u,6,u);return;}
  // Win-condition awareness: rotate pressure based on trinkets, defensives, healer CC and current cooldowns.
  const killTarget=this.killWindow(enemies);
  const winTarget=this.bestWinConditionTarget(enemies);
  if(killTarget&&killTarget!==t&&this.game.arena.los(u,killTarget)&&dist(u,killTarget)<=26){
   this.focus=killTarget;this.nextFocusAt=this.game.time+1.8;t=killTarget;
  }else if(winTarget&&winTarget!==t&&this.game.arena.los(u,winTarget)&&dist(u,winTarget)<=24&&this.targetWinConditionScore(winTarget,enemies)>this.targetWinConditionScore(t,enemies)+1.15){
   this.focus=winTarget;this.nextFocusAt=this.game.time+1.4;t=winTarget;
  }
  // Use crowd control to peel pressure or create a kill setup before blindly tunnelling the focus target.
  // Shadowblade owns a stricter setup sequence below. Generic random control made
  // expert rogues waste Blind before their bleed/Vendetta window was ready.
  if(u.cls!=='shadow'&&this.tryPlannedControl(enemies,t,d,!!killTarget))return;
  const targetDistance=dist(u,t),hasSight=this.game.arena.los(u,t);
  const allyOnTarget=allies.find(a=>a!==u&&a.alive&&a.ai&&a.ai.focus===t&&dist(a,t)<7.5);
  if(allyOnTarget&&dist(u,allyOnTarget)>14&&dist(u,t)>12){this.moveToward(allyOnTarget,false);return;}
  
  // Melee connect logic must run before the basic melee-range chase gate.
  // Previously Shadowblade and Warrior returned here while walking, so Pounce/Charge were never considered.
  if(hasSight&&u.cls==='shadow'&&targetDistance>3.6&&targetDistance<=18&&u.cds[1]<=0&&u.resource>=24){
    if(this.game.tryAbility(u,1,t))return;
  }
  if(hasSight&&u.cls==='warrior'&&targetDistance>3.4&&targetDistance<=17&&u.cds[1]<=0&&u.resource>=8){
    if(this.game.tryAbility(u,1,t))return;
  }
  // Opening stagger: ranged bots stage at the edge of their range briefly instead of all piling into mid at once.
  if(!this.game.isInCombat(u)&&this.game.time<this.openerHold&&(u.cls==='flame'||u.cls==='storm'||u.cls==='soul')&&hasSight&&targetDistance<=range+4){this.stopMove();return;}
  // Windwalker already exposes its full 17m dash as its active combat range when ready.
  if(!hasSight||targetDistance>range){this.moveToward(t,false);return;}
  if((u.cls==='flame'||u.cls==='storm')&&dist(u,t)<7.5&&!u.cast){this.moveToward(t,true);if(u.cls==='flame'&&u.cds[2]<=0){this.game.tryAbility(u,2,u);return;}}
  else this.stopMove();
  // Talent actions are considered only after a target, range and line-of-sight plan exists. This
  // prevents expanded toolkits from firing cooldowns randomly before the bot has a kill setup.
  if(u.cls!=='storm'&&this.tryTalentToolkit(enemies))return;
  const enemyHealer=enemies.find(e=>(e.cls==='sage'||e.cls==='pala'||e.cls==='disc')&&e.alive);
  if(enemyHealer&&enemyHealer.cast&&dist(u,enemyHealer)<23&&this.game.arena.los(u,enemyHealer)&&Math.random()<d.interrupt&&u.cls==='flame'&&u.cds[5]<=0){this.game.tryAbility(u,5,enemyHealer);return;}if(u.cls==='storm'&&u.cds[6]<=0){const shearTarget=enemies.find(e=>e.alive&&e.cast&&dist(u,e)<=25&&this.game.arena.los(u,e));if(shearTarget&&Math.random()<d.interrupt){this.game.tryAbility(u,6,shearTarget);return;}}
  if(u.cls==='flame'){
    const fireShield=AB[u.cls].findIndex(a=>a.name==='Fire Shield'||a.name==='Molten Armor'||a.name==='Alter Time');
    if(fireShield>=0&&u.cds[fireShield]<=0&&u.hp/u.maxHp<.68&&enemies.some(e=>this.attacking(u,e)||dist(e,u)<8)){this.game.tryAbility(u,fireShield,u);return;}
    const combust=AB[u.cls].findIndex(a=>a.name==='Combustion');
    if(combust>=0&&u.cds[combust]<=0&&!u.has('combustion')&&u.hp/u.maxHp>.35&&dist(u,t)<=26&&this.game.arena.los(u,t)&&t.hp/t.maxHp>.28){this.game.tryAbility(u,combust,u);return;}
    const bomb=AB[u.cls].findIndex(a=>a.name==='Living Bomb');
    if(bomb>=0&&u.cds[bomb]<=0&&!t.has('livingBomb')&&dist(u,t)<=24&&this.game.arena.los(u,t)&&!this.hasSetupCC(t)){this.game.tryAbility(u,bomb,t);return;}
    if(dist(u,t)<=8&&u.cds[2]<=0){this.game.tryAbility(u,2,u);return;}
    if(u.cds[1]<=0){this.game.tryAbility(u,1,t);return;}this.game.tryAbility(u,0,t);
  }
  if(u.cls==='shadow'){
    const expert=d.tier>=2||this.game.difficulty==='hard';
    const enemyHealer=enemies.find(e=>e.alive&&['sage','pala','disc'].includes(e.cls));
    const healerLocked=!!(enemyHealer&&this.hasSetupCC(enemyHealer));
    const targetHp=t.hp/t.maxHp;
    const defended=this.game.majorDefensiveActive?.(t)||t.has('iceBlock')||t.has('touchKarma')||t.has('warriorGuard')||t.has('evasion')||t.has('cloakShadows');
    const closeCaster=enemies.filter(e=>e.alive&&e.cast&&!e.cast.uninterruptible&&e.cast.left>.08&&dist(u,e)<=3.9&&this.game.arena.los(u,e)).sort((a,b)=>{
      const score=x=>(['sage','pala','disc'].includes(x.cls)?2:0)+(x.cast?.target?.hp/x.cast?.target?.maxHp<.60?2:0)+(x.cast?.left||0);
      return score(b)-score(a);
    })[0];
    if(closeCaster&&u.cds[6]<=0&&u.resource>=10&&(expert||Math.random()<d.interrupt)){this.game.tryAbility(u,6,closeCaster);return;}
    const vial=AB[u.cls].findIndex(a=>a.name==='Crimson Vial');
    if(vial>=0&&u.cds[vial]<=0&&u.hp/u.maxHp<.55){this.game.tryAbility(u,vial,u);return;}
    const evasion=AB[u.cls].findIndex(a=>a.name==='Evasion'||a.name==='Cloak of Shadows');
    if(evasion>=0&&u.cds[evasion]<=0&&u.hp/u.maxHp<.70&&enemies.some(e=>this.attacking(u,e)||dist(e,u)<6)){this.game.tryAbility(u,evasion,u);return;}
    if(dist(u,t)>3.6&&dist(u,t)<=18&&u.cds[1]<=0&&u.resource>=24){this.game.tryAbility(u,1,t);return;}
    const blind=AB[u.cls].findIndex(a=>a.name==='Blind');
    const hasPressureDot=!!(t.has('bleed')||t.has('poison'));
    const setupReady=!defended&&(targetHp<.84||hasPressureDot||!this.game.botCanSelfSaveSoon?.(t));
    if(blind>=0&&enemyHealer&&enemyHealer!==t&&u.cds[blind]<=0&&dist(u,enemyHealer)<=15&&this.game.arena.los(u,enemyHealer)&&this.ccValue(enemyHealer,'incap')>0&&!this.hasSetupCC(enemyHealer)&&setupReady&&(expert||Math.random()<.58)){
      this.game.tryAbility(u,blind,enemyHealer);return;
    }
    if(!u.has('smokePower')&&u.cds[3]<=0&&u.cds[5]<=0&&!defended&&(healerLocked||targetHp<.76||hasPressureDot&&targetHp<.88)){this.game.tryAbility(u,3,u);return;}
    const vend=AB[u.cls].findIndex(a=>a.name==='Vendetta');
    const gar=AB[u.cls].findIndex(a=>a.name==='Garrote');
    if(gar>=0&&u.cds[gar]<=0&&dist(u,t)<=4.5&&this.game.arena.los(u,t)&&!t.has('bleed')){this.game.tryAbility(u,gar,t);return;}
    if(vend>=0&&u.cds[vend]<=0&&dist(u,t)<=24&&this.game.arena.los(u,t)&&!t.has('vendetta')&&!defended&&hasPressureDot&&(healerLocked||targetHp<.72||this.game.unitUnderMajorOffensive?.(t))){this.game.tryAbility(u,vend,t);return;}
    if(u.has('venomEdge')&&u.cds[2]<=0){this.game.tryAbility(u,2,t);return;}
    if(u.cds[5]<=0&&!defended&&(healerLocked||targetHp<.70||t.has('vendetta'))&&this.ccValue(t,'stun')>0){this.game.tryAbility(u,5,t);return;}
    if(u.cds[2]<=0&&u.has('shadowMarks')&&(u.has('shadowMarks').stacks||0)>=2){this.game.tryAbility(u,2,t);return;}
    this.game.tryAbility(u,0,t);
  }
  if(u.cls==='wind'){
    const brewIndex=AB[u.cls].findIndex(a=>a.name==='Tigereye Brew');
    const brewStacks=windTigereyeStacks(u);
    const windPressure=t.hp/t.maxHp<.72||this.hasSetupCC(enemies.find(e=>e.alive&&(e.cls==='sage'||e.cls==='pala'||e.cls==='disc')));
    if(brewIndex>=0&&!u.has('tigereyeBrew')&&(brewStacks>=6||(brewStacks>=4&&(windPressure||u.has('tempestFlow')))||(brewStacks>=2&&t.hp/t.maxHp<.34))){
      if(this.game.tryAbility(u,brewIndex,u))return;
    }
    if(u.hp/u.maxHp<.42&&u.cds[5]<=0){this.game.tryAbility(u,5,u);return;}
    if(dist(u,t)>3.8&&u.cds[1]<=0&&!u.has('cloudstepDashCd')){if(this.game.tryAbility(u,1,t))return;if(dist(u,t)>4.1){this.moveToward(t,false);return;}}
    const closeCaster=enemies.find(e=>e.alive&&e.cast&&dist(u,e)<=3.5&&this.game.arena.los(u,e));
    if(closeCaster&&u.cds[3]<=0){this.game.tryAbility(u,3,closeCaster);return;}
    const strikeIndex=AB[u.cls].findIndex(a=>a.name==='Strike of the Windlord');
    if(strikeIndex>=0&&u.cds[strikeIndex]<=0&&u.resource>=(AB[u.cls][strikeIndex].cost||0)&&dist(u,t)<=4.2&&this.game.arena.los(u,t)&&(u.has('tigereyeBrew')||t.hp/t.maxHp<.90||u.cds[1]>0)){this.game.tryAbility(u,strikeIndex,t);return;}
    if(u.has('risingSunReady')&&dist(u,t)<=3.6&&this.game.arena.los(u,t)){this.game.tryAbility(u,0,t);return;}
    const deathIndex=AB[u.cls].findIndex(a=>a.name==='Touch of Death');
    if(deathIndex>=0&&u.cds[deathIndex]<=0&&!t.has('touchOfDeath')&&dist(u,t)<=4.3&&this.game.arena.los(u,t)&&u.has('tigereyeBrew')){this.game.tryAbility(u,deathIndex,t);return;}
    const fistsIndex=AB[u.cls].findIndex(a=>a.name==='Fists of Fury');
    if(fistsIndex>=0&&u.cds[fistsIndex]<=0&&u.resource>=(AB[u.cls][fistsIndex].cost||0)&&dist(u,t)<=5.1&&this.game.arena.los(u,t)&&(u.has('tigereyeBrew')||windPressure||t.hp/t.maxHp<.86)){this.game.tryAbility(u,fistsIndex,u);return;}
    const dragonIndex=AB[u.cls].findIndex(a=>a.name==='Whirling Dragon Punch');
    if(dragonIndex>=0&&u.cds[dragonIndex]<=0&&fistsIndex>=0&&u.cds[fistsIndex]>0&&dist(u,t)<=5.5&&this.game.arena.los(u,t)&&(u.has('tigereyeBrew')||windPressure)){this.game.tryAbility(u,dragonIndex,u);return;}
    if(u.cds[4]<=0&&dist(u,t)<=5.4&&t.hp/t.maxHp<.76&&this.ccValue(t,'stun')>0){this.game.tryAbility(u,4,t);return;}
    /* Zephyr Palm is the low-damage Flow builder; use it after Rising Sun, Strike, Fists, Touch of Death, interrupts and mobility have been considered. */this.game.tryAbility(u,0,t);
  }
  if(u.cls==='soul'){
    const darkPact=AB[u.cls].findIndex(a=>a.name==='Dark Pact');
    if(darkPact>=0&&u.cds[darkPact]<=0&&u.hp/u.maxHp<.58){this.game.tryAbility(u,darkPact,u);return;}
    if(u.hp/u.maxHp<.48&&u.cds[5]<=0){this.game.tryAbility(u,5,u);return;}
    if(!t.has('soulScar')){this.game.tryAbility(u,0,t);return;}
    const hasSoulImmolate=t.effects.some(e=>e.type==='burn'&&e.label==='Immolate'&&e.source===u&&e.time>0);
    if(!t.has('agony')&&!hasSoulImmolate){this.game.tryAbility(u,1,t);return;}
	    const chaos=AB[u.cls].findIndex(a=>a.name==='Chaos Bolt'),ua=t.has('unstableAffliction');
	    if(chaos<0&&(!ua||(ua.stacks||1)<3)){this.game.tryAbility(u,2,t);return;}
    const pandemic=AB[u.cls].findIndex(a=>a.name==='Pandemic Bloom');
    const shadowfury=AB[u.cls].findIndex(a=>a.name==='Shadowfury');
    if(pandemic>=0&&shadowfury>=0&&u.cds[pandemic]<=0&&u.cds[shadowfury]<=0&&!u.has('pandemicSurge')&&dist(u,t)<=20&&this.game.arena.los(u,t)&&this.ccValue(t,'stun')>0){this.game.tryAbility(u,shadowfury,t);return;}
    if(pandemic>=0&&u.cds[pandemic]<=0&&dist(u,t)<=25&&this.game.arena.los(u,t)&&t.hp/t.maxHp<.88){this.game.tryAbility(u,pandemic,t);return;}
	    if(chaos>=0&&u.cds[chaos]<=0&&dist(u,t)<=25&&this.game.arena.los(u,t)&&!this.hasSetupCC(t)){this.game.tryAbility(u,chaos,t);return;}
	    const siphon=AB[u.cls].findIndex(a=>a.name==='Essence Siphon');
	    if(t.has('soulScar')&&(t.has('agony')||hasSoulImmolate)&&(chaos>=0||(ua?.stacks||0)>=3)&&siphon>=0&&u.cds[siphon]<=0){this.game.tryAbility(u,siphon,t);return;}
    const horror=AB[u.cls].findIndex(a=>a.name==='Mortal Horror');
    const enemyHealer=enemies.find(e=>e.alive&&(e.cls==='sage'||e.cls==='pala'||e.cls==='disc'));
    if(horror>=0&&enemyHealer&&enemyHealer!==t&&u.cds[horror]<=0&&dist(u,enemyHealer)<=20&&this.game.arena.los(u,enemyHealer)&&this.ccValue(enemyHealer,'fear')>0&&!this.hasSetupCC(enemyHealer)&&t.hp/t.maxHp<.78){this.game.tryAbility(u,horror,enemyHealer);return;}
    if(u.cds[4]<=0&&dist(u,t)<10){this.game.tryAbility(u,4,t);return;}
    this.game.tryAbility(u,0,t);return;
  }
  if(u.cls==='storm'){
    const idx=name=>AB[u.cls].findIndex(a=>a.name===name);
    const flameShock=idx('Flame Shock'),lava=idx('Volcanic Eruption'),chain=idx('Healing Surge'),stormkeeper=idx('Stormkeeper'),totem=idx('Totem Mastery'),frost=idx('Frost Shock'),skybreaker=idx('Skybreaker Pulse'),healingStream=idx('Healing Stream Totem'),thunderstep=idx('Thunderstep');
    const healer=enemies.find(e=>e.alive&&['sage','pala','disc'].includes(e.cls));
    const setup=!!(healer&&this.hasSetupCC(healer));
    const visible=enemies.filter(e=>e.alive&&dist(u,e)<=25&&this.game.arena.los(u,e));
    const targetHp=t.hp/t.maxHp,selfHp=u.hp/u.maxHp;
    const pressure=targetHp<.80||setup||this.game.unitUnderMajorOffensive?.(t)||u.has('stormkeeper')||u.has('tempestBolts');
    const mainShock=t.has('flameShock');

    // Interrupt first when a meaningful cast is available.
    const caster=visible.find(e=>e.cast&&!e.cast.uninterruptible);
    if(caster&&u.cds[6]<=0&&Math.random()<Math.max(.72,d.interrupt)){this.game.tryAbility(u,6,caster);return;}

    // A Stormwarden is a damage dealer. Healing Surge is an emergency recovery tool and never
    // replaces pressure on a vulnerable enemy.
    const killPressure=targetHp<.46||setup||this.game.unitUnderMajorOffensive?.(t);
    if(chain>=0&&u.cds[chain]<=0&&u.resource>=(AB[u.cls][chain].cost||0)&&selfHp<.38&&!killPressure){this.stopMove();this.game.tryAbility(u,chain,u);return;}
    if(selfHp<.40&&u.cds[3]<=0){this.game.tryAbility(u,3,u);return;}

    // Establish the DoT and offensive amplifiers before committing the stun. High-rated bots hold
    // the eruption until this setup exists, then unload the entire instant window together.
    if(flameShock>=0&&u.resource>=(AB[u.cls][flameShock].cost||0)&&dist(u,t)<=25&&this.game.arena.los(u,t)&&(!mainShock||mainShock.time<=2.5)){this.game.tryAbility(u,flameShock,t);return;}
    if(totem>=0&&u.cds[totem]<=0&&!u.has('totemMastery')&&selfHp>.45&&visible.length&&(pressure||d.tier>=2)){this.game.tryAbility(u,totem,u);return;}
    if(stormkeeper>=0&&u.cds[stormkeeper]<=0&&!u.has('stormkeeper')&&selfHp>.48&&dist(u,t)<=25&&this.game.arena.los(u,t)&&(pressure||d.tier>=2)){this.game.tryAbility(u,stormkeeper,u);return;}
    if(skybreaker>=0&&u.cds[skybreaker]<=0&&dist(u,t)>7&&dist(u,t)<=15&&this.game.arena.los(u,t)&&(u.has('stormkeeper')||pressure)){this.moveToward(t,false);return;}
    if(skybreaker>=0&&u.cds[skybreaker]<=0&&dist(u,t)<=7&&this.ccValue(t,'stun')>0&&(u.has('stormkeeper')||pressure||caster)){this.game.tryAbility(u,skybreaker,t);return;}
    if(u.has('volcanicEruptionReady')&&lava>=0&&u.cds[lava]<=0&&dist(u,t)<=24&&this.game.arena.los(u,t)){this.game.tryAbility(u,lava,t);return;}
    if(u.has('tempestBolts')||u.has('stormkeeper')){this.game.tryAbility(u,0,t);return;}

    if(thunderstep>=0&&u.cds[thunderstep]<=0&&selfHp<.68&&enemies.some(e=>e.alive&&['shadow','wind','warrior'].includes(e.cls)&&dist(u,e)<=5)){this.game.tryAbility(u,thunderstep,u);return;}
    if(healingStream>=0&&u.cds[healingStream]<=0&&!this.game.units.some(x=>x.healingStreamTotem&&x.alive&&x.totemOwner===u)&&allies.some(a=>!a.healingStreamTotem&&a.hp/a.maxHp<.82)){this.game.tryAbility(u,healingStream,u);return;}
    if(u.cds[5]<=0&&dist(u,t)>7&&(setup||this.attacking(u,t))){this.game.tryAbility(u,5,t);return;}

    // Forked Current and Arc Spark are the damage fillers. Cleave comes before optional recovery.
    if(u.cds[1]<=0&&visible.length>=2){this.game.tryAbility(u,1,t);return;}
    const hurtAlly=allies.filter(a=>a.alive&&dist(u,a)<=24&&this.game.arena.los(u,a)).sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];
    if(chain>=0&&hurtAlly&&hurtAlly.hp/hurtAlly.maxHp<.42&&targetHp>.54&&u.cds[chain]<=0&&u.resource>=(AB[u.cls][chain].cost||0)){this.stopMove();this.game.tryAbility(u,chain,hurtAlly);return;}

    // Use Frost Shock only to preserve distance or secure uptime, not as random filler.
    if(frost>=0&&u.cds[frost]<=0&&dist(u,t)>8&&dist(u,t)<=24&&this.game.arena.los(u,t)&&!t.has('slow')&&!t.has('root')&&enemies.some(e=>e.alive&&['shadow','wind','warrior'].includes(e.cls)&&this.attacking(u,e))){this.game.tryAbility(u,frost,t);return;}
    this.game.tryAbility(u,0,t);
  }
  if(u.cls==='warrior'){
   const stormbolt=AB[u.cls].findIndex(a=>a.name==='Stormbolt');
   const boltTarget=enemies.filter(e=>e.alive&&dist(u,e)<=22&&this.game.arena.los(u,e)&&!e.has('stun')).sort((a,b)=>(b.cast?2:0)+(1-b.hp/b.maxHp)-((a.cast?2:0)+(1-a.hp/a.maxHp)))[0];
   const opposingHealer=enemies.find(e=>e.alive&&['sage','pala','disc'].includes(e.cls));
   if(stormbolt>=0&&boltTarget&&u.cds[stormbolt]<=0&&(boltTarget.cast||boltTarget.hp/boltTarget.maxHp<.72||this.hasSetupCC(opposingHealer))){this.game.tryAbility(u,stormbolt,boltTarget);return;}
   if(dist(u,t)>3.7&&dist(u,t)<=17&&u.cds[1]<=0&&u.resource>=8){this.game.tryAbility(u,1,t);return;}
   const caster=enemies.find(e=>e.alive&&e.cast&&!e.cast.uninterruptible&&dist(u,e)<=4.5&&this.game.arena.los(u,e));
   const skull=AB[u.cls].findIndex(a=>a.name==='Skullbreaker');
   if(caster&&skull>=0&&u.cds[skull]<=0){this.game.tryAbility(u,skull,caster);return;}
   if(caster&&u.cds[3]<=0&&Math.random()<d.interrupt){this.game.tryAbility(u,3,caster);return;}
   const intercept=AB[u.cls].findIndex(a=>a.name==='Intercept'),hurtPartner=allies.filter(a=>a!==u&&a.alive&&dist(u,a)<=25&&this.game.arena.los(u,a)).sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];
   if(intercept>=0&&hurtPartner&&hurtPartner.hp/hurtPartner.maxHp<.45&&u.cds[intercept]<=0){this.game.tryAbility(u,intercept,hurtPartner);return;}
   if(u.hp/u.maxHp<.4&&u.cds[6]<=0){this.game.tryAbility(u,6,u);return;}
   if(u.cds[4]<=0&&enemies.some(e=>e.alive&&e.cast&&dist(u,e)<22)&&Math.random()<.5){this.game.tryAbility(u,4,u);return;}
   const warbreaker=AB[u.cls].findIndex(a=>a.name==='Warbreaker');
   if(warbreaker>=0&&u.cds[warbreaker]<=0&&dist(u,t)<=4.5&&this.game.arena.los(u,t)&&(t.hp/t.maxHp<.85||u.cds[0]<=0)){this.game.tryAbility(u,warbreaker,t);return;}
   if(!t.has('bleed')&&u.cds[2]<=0){this.game.tryAbility(u,2,t);return;}
   const warriorPeel=this.peelThreat(enemies,allies,8);
   if(u.cds[5]<=0&&enemies.some(e=>e.alive&&dist(u,e)<=8&&this.ccValue(e,'fear')>0)&&((warriorPeel&&dist(u,warriorPeel)<=8&&Math.random()<.82)||enemies.filter(e=>e.alive&&dist(u,e)<=8).length>=2&&Math.random()<.42)){this.game.tryAbility(u,5,u);return;}
   this.game.tryAbility(u,0,t);return;
  }
 }

 antiMageHealerResponse(allies,enemies){
  const u=this.u;if(!['sage','pala','disc'].includes(u.cls))return false;
  const mages=enemies.filter(e=>e.alive&&e.cls==='flame');
  if(!mages.length)return false;
  const mage=mages.slice().sort((a,b)=>dist(a,u)-dist(b,u))[0];
  const polymorphed=allies.filter(a=>a!==u&&a.alive&&a.has('poly')).sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];
  const cleanse=AB[u.cls].findIndex(a=>a.type==='cleanse');
  const cleanseReady=cleanse>=0&&u.cds[cleanse]<=0&&u.resource>=(AB[u.cls][cleanse].cost||0);

  if(polymorphed){
   if(cleanseReady){
    const inLine=dist(u,polymorphed)<=28&&this.game.arena.los(u,polymorphed);
    if(inLine){
     if(u.cast){u.cast=null;this.game.float(u,'CANCEL CAST · DISPEL POLYMORPH','info');}u.gcd=0;
     if(this.game.tryAbility(u,cleanse,polymorphed,false)){this.stopMove();return true;}
    }else{
     if(u.cast){u.cast=null;u.gcd=0;}if(u.cls==='disc'){const body=AB[u.cls].findIndex(a=>a.name==='Angelic Body');if(body>=0&&u.cds[body]<=0)this.game.tryAbility(u,body,u);}if(this.moveToHealLine(polymorphed,enemies,true))return true;
    }
   }

   // Cleanse is unavailable: deny the mage free damage while preserving a line to the controlled teammate.
   if(this.game.arena.los(mage,u)){
    const selfCritical=u.hp/u.maxHp<.46;
    const usefulEmergency=u.cast&&u.cast.target===u&&['heal','holyLight','discMend'].includes(u.cast.a?.type)&&selfCritical;
    if(u.cast&&!usefulEmergency)u.cast=null;
    const hide=this.pillarKitePoint(mage,polymorphed);
    if(hide&&!this.game.arena.los(mage,hide)&&dist(u,hide)>.65){this.moveToPoint(hide.x,hide.z,1.05);return true;}
   }
  }

  // If the mage is actively free-casting at the healer, stand on the genuinely hidden side of the pillar.
  const magePressure=(mage.cast&&mage.cast.target===u)||(mage.ai&&mage.ai.focus===u)||(mage===this.game.player&&this.game.target===u);
  if(magePressure&&this.game.arena.los(mage,u)&&u.hp/u.maxHp<.84){
   const healTarget=allies.filter(a=>a.alive&&!a.has('smokeBomb')).sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0]||u;
   if(healTarget.hp/healTarget.maxHp>.42){
    const hide=this.pillarKitePoint(mage,healTarget);
    if(hide&&!this.game.arena.los(mage,hide)&&dist(u,hide)>.7){
     if(u.cast&&u.cast.left>.28)u.cast=null;
     this.moveToPoint(hide.x,hide.z,.95);return true;
    }
   }
  }
  return false;
 }
 survivorHealerDuel(allies,enemies){
  const u=this.u;if(allies.filter(a=>a.alive).length!==1)return false;
  const foe=enemies.filter(e=>e.alive).sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp||dist(u,a)-dist(u,b))[0];
  if(!foe){this.stopMove();return true;}
  this.focus=foe;const idx=name=>AB[u.cls].findIndex(a=>a.name===name),hp=u.hp/u.maxHp,los=this.game.arena.los(u,foe),range=dist(u,foe);
  if(u.cast)return true;
  if(u.cls==='pala'){
   const guard=idx('Divine Protection'),shock=idx('Holy Shock'),light=idx('Holy Light'),stun=idx('Hammer of Justice'),steed=idx('Divine Steed'),wings=idx('Avenging Wings'),judgement=idx('Judgement');
   if(hp<.55&&guard>=0&&u.cds[guard]<=0){this.game.tryAbility(u,guard,u);return true;}
   if(hp<.48&&shock>=0&&u.cds[shock]<=0&&u.resource>=8){this.stopMove();this.game.tryAbility(u,shock,u);return true;}
   if(hp<.82&&light>=0&&u.resource>=6){this.stopMove();this.game.tryAbility(u,light,u);return true;}
   if(wings>=0&&u.cds[wings]<=0&&!u.has('avengingWings')&&(hp<.72||foe.hp/foe.maxHp<.75)){this.game.tryAbility(u,wings,u);return true;}
   if(stun>=0&&u.cds[stun]<=0&&los&&range<=10&&this.ccValue(foe,'stun')>0){this.stopMove();this.game.tryAbility(u,stun,foe);return true;}
   if(judgement>=0&&u.cds[judgement]<=0&&los&&range<=24){this.stopMove();this.game.tryAbility(u,judgement,foe);return true;}
   if(shock>=0&&u.cds[shock]<=0&&u.resource>=8&&los&&range<=28){this.stopMove();this.game.tryAbility(u,shock,foe);return true;}
   if((!los||range>3.2)&&steed>=0&&u.cds[steed]<=0&&!u.has('divineSteed'))this.game.tryAbility(u,steed,u);
   this.moveToward(foe,false);return true;
  }
  if(u.cls==='disc'){
   const shield=idx('Power Shield'),mend=idx('Shadow Mend'),penance=idx('Penance'),solace=idx('Solace'),smite=idx('Smite'),fear=idx('Psychic Scream'),dark=idx('Dark Archangel');
   if(hp<.78&&shield>=0&&u.cds[shield]<=0&&u.resource>=6&&!u.has('shield')){this.game.tryAbility(u,shield,u);return true;}
   if(hp<.42&&mend>=0&&u.resource>=6){this.stopMove();this.game.tryAbility(u,mend,u);return true;}
   if(fear>=0&&u.cds[fear]<=0&&los&&range<=8&&this.ccValue(foe,'fear')>0){this.game.tryAbility(u,fear,u);return true;}
   if(dark>=0&&u.cds[dark]<=0&&hp>.72){this.game.tryAbility(u,dark,u);return true;}
   if(penance>=0&&u.cds[penance]<=0&&u.resource>=8&&los&&range<=25){this.game.tryAbility(u,penance,foe);return true;}
   if(solace>=0&&u.cds[solace]<=0&&los&&range<=25){this.game.tryAbility(u,solace,foe);return true;}
   if(smite>=0&&u.resource>=4&&los&&range<=25){this.stopMove();this.game.tryAbility(u,smite,foe);return true;}
   this.moveToward(foe,false);return true;
  }
  const tide=idx('Renewal Tide'),hot=idx('Blooming Echo'),mend=idx('Verdant Mend'),sleep=idx('Lullaby Bloom'),escape=idx('Fae Retreat');
  if(hp<.42&&tide>=0&&u.cds[tide]<=0&&u.resource>=18){this.stopMove();this.game.tryAbility(u,tide,u);return true;}
  if(hp<.72&&hot>=0&&u.resource>=8&&!u.has('hot')){this.stopMove();this.game.tryAbility(u,hot,u);return true;}
  if(hp<.82&&mend>=0&&u.resource>=6){this.stopMove();this.game.tryAbility(u,mend,u);return true;}
  if(sleep>=0&&u.cds[sleep]<=0&&u.resource>=8&&los&&range<=24&&this.ccValue(foe,'incap')>0){this.stopMove();this.game.tryAbility(u,sleep,foe);return true;}
  if(range<7&&escape>=0&&u.cds[escape]<=0)this.game.tryAbility(u,escape,u);
  if(!los||range>22)this.moveToward(foe,false);else if(range<14)this.moveToward(foe,true);else this.stopMove();
  return true;
 }
 paladinHealer(allies,enemies,d){const u=this.u;if(this.antiMageHealerResponse(allies,enemies))return;const healable=allies.filter(a=>!a.has('smokeBomb'));const low=this.chooseHealTarget(healable.length?healable:allies,enemies);const hp=low.hp/low.maxHp;const injured=allies.filter(a=>a.hp/a.maxHp<.74).length;const controlledAlly=allies.filter(a=>a!==u&&a.alive&&a.effects.some(e=>['poly','sleep','blind','windIncap','fear','root','slow'].includes(e.type))).sort((a,b)=>{const score=x=>x.has('poly')||x.has('sleep')||x.has('blind')||x.has('windIncap')||x.has('fear')?5:x.has('root')?3:1;return score(b)-score(a);})[0];const dispelTarget=allies.filter(a=>a.alive&&dist(u,a)<=28&&this.game.arena.los(u,a)&&a.effects.some(e=>['poly','sleep','blind','windIncap','fear','root','slow'].includes(e.type))).sort((a,b)=>{const score=x=>x.has('poly')||x.has('sleep')||x.has('blind')||x.has('windIncap')||x.has('fear')?5:x.has('root')?3:1;return score(b)-score(a);})[0];const threats=enemies.filter(e=>e.alive).sort((a,b)=>dist(a,u)-dist(b,u));const threat=threats[0];const enemyHealer=enemies.find(e=>e.alive&&['sage','pala','disc'].includes(e.cls));const expert=d.tier>=2||this.game.difficulty==='hard';const rangedPressure=threats.find(e=>e.alive&&((e.cast&&e.cast.target===u)||(this.attacking(u,e)&&dist(e,u)<=27&&this.game.arena.los(e,u))));const targeted=threats.some(e=>(e===this.game.player&&this.game.target===u)||(e.ai&&e.ai.focus===u));const peelThreat=this.peelThreat(enemies,allies,10);const danger=!!(threat&&(dist(threat,u)<10||targeted)||rangedPressure);const partnerLocked=allies.find(a=>a!==u&&a.alive&&['poly','fear','sleep','blind','windIncap','furyStun','cheapStun','stun'].some(type=>a.has(type)));const incomingCC=enemies.find(e=>e.alive&&e.cast&&e.cast.target===u&&['poly','sleep','fear'].includes(e.cast.a?.type));const swapThreat=threats.find(e=>e.alive&&!['sage','pala','disc'].includes(e.cls))||threat;const isolated=!!(partnerLocked&&swapThreat&&(targeted||dist(swapThreat,u)<18||this.attacking(u,swapThreat)||u.hp/u.maxHp<.90));
  if(this.openerHealerSetup(allies,enemies,low))return;
  if(!this.game.isInCombat(u)&&!u.mounted&&!u.cast&&dist(u,low)>12&&this.game.time>u.aiMountDelay){this.game.tryMount(u,false);return;}
  if(controlledAlly&&(!this.game.arena.los(u,controlledAlly)||dist(u,controlledAlly)>28)){if(u.cast)u.cast=null;if(u.cds[6]<=0&&!u.has('divineSteed'))this.game.tryAbility(u,6,u);this.moveToward(controlledAlly,false);return;}
  if(low!==u&&u.hp/u.maxHp>.46&&this.moveToHealLine(low,enemies,hp<.88||this.game.unitUnderMajorOffensive(low)||low.has('smokeBomb')))return;
  const lastAlive=allies.filter(a=>a.alive).length===1;
  if(lastAlive){
   if(u.hp/u.maxHp<.55&&u.cds[4]<=0){this.game.tryAbility(u,4,u);return;}
   if(u.hp/u.maxHp<.50&&u.cds[1]<=0&&u.resource>=9){this.stopMove();this.game.tryAbility(u,1,u);return;}
   if(u.hp/u.maxHp<.84&&u.resource>=7){this.stopMove();this.game.tryAbility(u,0,u);return;}
   const foe=threats.find(e=>e.alive&&dist(u,e)<=10&&this.game.arena.los(u,e));
   if(foe&&u.cds[5]<=0&&this.ccValue(foe,'stun')>0){this.stopMove();this.game.tryAbility(u,5,foe);return;}
   if(threat&&u.hp/u.maxHp>.62&&u.cds[1]<=0&&u.resource>=9&&dist(u,threat)<=28&&this.game.arena.los(u,threat)){this.stopMove();this.game.tryAbility(u,1,threat);return;}
   if(threat&&dist(u,threat)<8){if(u.cds[6]<=0&&!u.has('divineSteed'))this.game.tryAbility(u,6,u);if(!u.cast)this.moveToward(threat,true);return;}
   this.stopMove();return;
  }
  if(dispelTarget&&u.cds[7]<=0&&u.resource>=5){if(this.delayedDispel(dispelTarget,7))return;if(!isolated&&u.hp/u.maxHp>.55){this.stopMove();return;}}else this.dispelDecision=null;
  if(incomingCC){if(u.cds[6]<=0&&!u.has('divineSteed')){this.game.tryAbility(u,6,u);this.moveToward(incomingCC,true);return;}if(!u.cast){this.moveToward(incomingCC,true);return;}}
  if(this.healerReposition(allies,enemies,low,{threat:rangedPressure||swapThreat||threat}))return;
  if(isolated){
   if(u.cast&&u.hp/u.maxHp<.68)u.cast=null;
   if(u.hp/u.maxHp<.80&&u.cds[4]<=0){this.game.tryAbility(u,4,u);return;}
   if(peelThreat&&u.cds[5]<=0&&dist(u,peelThreat)<=10&&this.game.arena.los(u,peelThreat)&&!peelThreat.has('stun')){this.stopMove();this.game.tryAbility(u,5,peelThreat);return;}
   if(u.hp/u.maxHp<.84&&u.cds[1]<=0&&u.resource>=9){this.stopMove();this.game.tryAbility(u,1,u);return;}
   if(u.cds[6]<=0&&!u.has('divineSteed')){this.game.tryAbility(u,6,u);this.moveToward(swapThreat,true);return;}
   if(!u.cast){this.moveToward(swapThreat,true);return;}
  }
  if((!this.game.arena.los(u,low)||dist(u,low)>27)&&u.cds[6]<=0&&!u.has('divineSteed')){this.game.tryAbility(u,6,u);return;}
  if(!this.game.arena.los(u,low)||dist(u,low)>27){if(u.cast&&hp<.55)u.cast=null;if(!u.cast)this.moveToward(low,false);return;}
  const guardian=AB[u.cls].findIndex(a=>a.name==='Guardian Angel');
  const word=AB[u.cls].findIndex(a=>a.name==='Word of Glory');
  const toll=AB[u.cls].findIndex(a=>a.name==='Divine Toll');const faith=AB[u.cls].findIndex(a=>a.name==='Bestow Faith');
  const sacrifice=AB[u.cls].findIndex(a=>a.name==='Blessing of Sacrifice');
  const wings=AB[u.cls].findIndex(a=>a.name==='Avenging Wings');
  const teammateBurst=low&&low!==u&&(hp<.76||low.has('smokeBomb')||this.game.unitUnderBurst(low)||this.enemyBurstPotential(low,enemies)>=2.5);
  const majorBurst=this.game.unitUnderMajorOffensive(low)||low.has('smokeBomb')||this.game.unitUnderBurst(low)||this.enemyBurstPotential(low,enemies)>=2.5;
  const selfRisk=this.enemyBurstPotential(u,enemies)+(targeted?1.2:0)+(u.hp/u.maxHp<.70?1.4:0);
  if(teammateBurst&&sacrifice>=0&&u.cds[sacrifice]<=0&&!low.has('sacrifice')&&u.resource>=(AB[u.cls][sacrifice].cost||0)){
   if(u.cds[4]<=0&&!u.has('defensive')&&selfRisk>=2.2){this.game.tryAbility(u,4,u);return;}
   this.stopMove();this.game.tryAbility(u,sacrifice,low);return;
  }
  if(wings>=0&&u.cds[wings]<=0&&!u.has('avengingWings')&&(injured>=2||majorBurst&&hp<.84||hp<.54)){this.game.tryAbility(u,wings,u);return;}
  const proactiveHeal=low&&low.alive&&low!==u&&hp<.94&&dist(u,low)<=28&&this.game.arena.los(u,low);
  if(proactiveHeal&&!danger&&!partnerLocked){
   if(faith>=0&&u.cds[faith]<=0&&!low.has('bestowFaith')&&hp<.94&&this.enemyBurstPotential(low,enemies)>=1.0){this.stopMove();this.game.tryAbility(u,faith,low);return;}
   if(hp<.91&&u.cds[1]<=0&&u.resource>=9){this.stopMove();this.game.tryAbility(u,1,low);return;}
   if(hp<.86&&u.resource>=7&&!u.cast){this.stopMove();this.game.tryAbility(u,0,low);return;}
  }
  if(hp<.34&&guardian>=0&&u.cds[guardian]<=0&&u.resource>=(AB[u.cls][guardian].cost||0)){this.stopMove();this.game.tryAbility(u,guardian,low);return;}
  if(hp<.48&&word>=0&&u.cds[word]<=0&&u.resource>=(AB[u.cls][word].cost||0)){this.stopMove();this.game.tryAbility(u,word,low);return;}
  if(hp<.56&&toll>=0&&u.cds[toll]<=0&&u.resource>=(AB[u.cls][toll].cost||0)){this.stopMove();this.game.tryAbility(u,toll,low);return;}
  if(hp<.38&&low!==u&&u.cds[2]<=0&&u.resource>=12){this.stopMove();this.game.tryAbility(u,2,low);return;}
  if(hp<.76&&u.cds[1]<=0&&u.resource>=9){this.stopMove();this.game.tryAbility(u,1,low);return;}
  if(faith>=0&&u.cds[faith]<=0&&!low.has('bestowFaith')&&hp<.88&&u.resource>=(AB[u.cls][faith].cost||0)){this.stopMove();this.game.tryAbility(u,faith,low);return;}
  if(danger&&u.hp/u.maxHp<.65&&u.cds[4]<=0){this.game.tryAbility(u,4,u);return;}
  if((danger||peelThreat)&&u.cds[5]<=0&&dist(u,peelThreat||threat)<=10&&this.game.arena.los(u,peelThreat||threat)&&!(peelThreat||threat).has('stun')&&this.ccValue(peelThreat||threat,'stun')>0){this.stopMove();this.game.tryAbility(u,5,peelThreat||threat);return;}
  if(hp<.84&&u.resource>=7){
   const kicker=this.interruptThreat(enemies);
   if(kicker&&hp>.62&&!u.has('infusion')){
    if(u.cds[1]<=0&&u.resource>=9){this.stopMove();this.game.tryAbility(u,1,low);return;}
    if(!u.cast){const safe=this.pillarKitePoint(kicker,low);if(safe)this.moveToPoint(safe.x,safe.z,.9);else this.moveToward(kicker,true);return;}
   }
   this.stopMove();this.game.tryAbility(u,0,low);return;}
  if(!danger&&hp>.84){const killable=enemies.find(e=>e.alive&&e.hp/e.maxHp<.34&&dist(u,e)<=28&&this.game.arena.los(u,e));if(killable){if(u.cds[5]<=0&&dist(u,killable)<=10&&this.ccValue(killable,'stun')>0){this.stopMove();this.game.tryAbility(u,5,killable);return;}if(u.cds[1]<=0&&u.resource>=9){this.stopMove();this.game.tryAbility(u,1,killable);return;}}}
  const judgement=AB[u.cls].findIndex(a=>a.name==='Judgement'||a.name==='Judgment');
  const blind=AB[u.cls].findIndex(a=>a.name==='Blinding Light');
  const killTarget=this.coordinatedTarget(enemies)||threat;
  const offensiveToll=expert&&toll>=0&&u.cds[toll]<=0&&killTarget&&hp>.88&&u.hp/u.maxHp>.78&&u.resource>=(AB[u.cls][toll].cost||0)&&dist(u,killTarget)<=28&&this.game.arena.los(u,killTarget)&&(this.enemyHealerState(enemies).locked||killTarget.hp/killTarget.maxHp<.44||this.game.unitUnderMajorOffensive?.(killTarget));
  if(offensiveToll){this.stopMove();this.game.tryAbility(u,toll,killTarget);return;}
  if(!danger&&hp>.84&&threat&&judgement>=0&&u.cds[judgement]<=0&&dist(u,threat)<=24&&this.game.arena.los(u,threat)&&(expert||u.resource<84)){this.stopMove();this.game.tryAbility(u,judgement,threat);return;}
  if(!danger&&hp>.92&&blind>=0&&u.cds[blind]<=0&&enemyHealer&&dist(u,enemyHealer)<=16&&this.game.arena.los(u,enemyHealer)&&this.ccValue(enemyHealer,'incap')>0&&!this.hasSetupCC(enemyHealer)){this.stopMove();this.game.tryAbility(u,blind,enemyHealer);return;}
  if(!danger&&hp>.90&&threat&&u.cds[1]<=0&&u.resource>=9&&dist(u,threat)<=28&&this.game.arena.los(u,threat)){this.stopMove();this.game.tryAbility(u,1,threat);return;}
  if(danger&&u.cds[6]<=0&&!u.has('divineSteed')){this.game.tryAbility(u,6,u);this.moveToward(threat,true);return;}
  if(danger){if(u.cast&&u.hp/u.maxHp<.74)u.cast=null;if(!u.cast)this.moveToward(threat,true);}else if(!danger)this.stopMove();
 }

 disciplineHealer(allies,enemies,d){
  const u=this.u;if(this.antiMageHealerResponse(allies,enemies))return;
  const available=allies.filter(a=>a.alive&&!a.has('smokeBomb'));
  const low=this.chooseHealTarget(available.length?available:allies,enemies);
  const hp=low.hp/low.maxHp,selfHp=u.hp/u.maxHp;
  const idx=name=>AB[u.cls].findIndex(a=>a.name===name);
  const smite=idx('Smite'),shield=idx('Power Shield'),penance=idx('Penance'),mend=idx('Shadow Mend'),solace=idx('Solace'),pain=idx('Pain Suppression'),radiance=idx('Ultimate Radiance'),purify=idx('Purify'),fear=idx('Psychic Scream'),fade=idx('Fade'),archangel=idx('Archangel'),darkArch=idx('Dark Archangel'),angelicBody=idx('Angelic Body');
  const expert=d.tier>=2||this.game.difficulty==='hard';
  const controlled=allies.filter(a=>a.alive&&a.effects.some(e=>['poly','sleep','blind','windIncap','fear','root','slow'].includes(e.type))).sort((a,b)=>(b.has('poly')?5:b.has('fear')?4:b.has('root')?2:1)-(a.has('poly')?5:a.has('fear')?4:a.has('root')?2:1))[0];
  if(controlled&&purify>=0&&u.cds[purify]<=0&&dist(u,controlled)<=28&&this.game.arena.los(u,controlled)){if(u.cast){u.cast=null;u.gcd=0;}this.game.tryAbility(u,purify,controlled);return;}
  if(low!==u&&(!this.game.arena.los(u,low)||dist(u,low)>28)&&angelicBody>=0&&u.cds[angelicBody]<=0){this.game.tryAbility(u,angelicBody,u);return;}if(low!==u&&this.moveToHealLine(low,enemies,hp<.78||this.game.unitUnderMajorOffensive(low)))return;

  const burst=this.game.unitUnderMajorOffensive(low)||low.has('smokeBomb')||this.game.unitUnderBurst(low);
  const burstScore=this.enemyBurstPotential(low,enemies),selfBurst=this.enemyBurstPotential(u,enemies),holyLocked=!!u.has('lock_holy');
  const injured=allies.filter(a=>a.alive&&a.hp/a.maxHp<.72).length;
  const targeted=enemies.some(e=>this.attacking(u,e)||(e.cast&&e.cast.target===u));
  if((hp<.52||burst&&hp<.86||expert&&burstScore>=2.5&&hp<.90)&&pain>=0&&u.cds[pain]<=0&&!low.has('painSuppression')){if(u.cast){u.cast=null;u.gcd=0;}this.game.tryAbility(u,pain,low);return;}
  const splitPressure=allies.filter(a=>a.alive&&a.hp/a.maxHp<.82).length>=2&&allies.some(a=>a.hp/a.maxHp<.74);
  if((hp<.38||splitPressure||burstScore>=3.5&&hp<.62)&&radiance>=0&&u.cds[radiance]<=0&&u.resource>=(AB[u.cls][radiance].cost||0)){if(u.cast){u.cast=null;u.gcd=0;}this.game.tryAbility(u,radiance,u);return;}
  if((selfHp<.56||targeted&&selfHp<.80||selfBurst>=2.5&&selfHp<.86)&&fade>=0&&u.cds[fade]<=0){this.game.tryAbility(u,fade,u);return;}

  // Establish a safe pillar edge before choosing filler damage. Mobile
  // Penance and instant Solace can be used during this route; Smite below is
  // intentionally withheld until the bot has stopped.
  const repositioning=this.disciplineTacticalPositioning(allies,enemies,low);

  // Maintain or refresh Atonement with Power Shield before starting the damage
  // conversion loop. A mark with less than three seconds remaining is treated
  // as expiring, which prevents gaps without wasting shields every decision.
  const atonementTime=a=>a.effects.filter(e=>e.type==='atonement'&&e.source===u).reduce((time,e)=>Math.max(time,e.time||0),0);
  const needsAtonement=allies.filter(a=>a.alive&&atonementTime(a)<(expert?4.5:3)).sort((a,b)=>{
    const score=x=>this.healUrgency(x,enemies)+(x!==u?1.20:(targeted ? .55 : 0))+(x===low ? .45 : 0);
    return score(b)-score(a);
  })[0];
  if(shield>=0&&u.cds[shield]<=0&&needsAtonement&&u.resource>=(AB[u.cls][shield].cost||0)&&!needsAtonement.has('shield')&&(expert||needsAtonement===low||needsAtonement.hp/needsAtonement.maxHp<.92)){this.game.tryAbility(u,shield,needsAtonement);return;}

  const target=this.disciplineDamageTarget(allies,enemies);
  const partner=allies.find(a=>a!==u&&a.alive),partnerTarget=partner===this.game.player?this.game.target:partner?.ai?.focus;
  const atoned=allies.filter(a=>a.alive&&atonementTime(a)>0).length;
  const penanceReady=penance>=0&&u.cds[penance]<=0&&u.resource>=(AB[u.cls][penance].cost||0);
  const canDamage=!!(target&&dist(u,target)<=25&&this.game.arena.los(u,target));

  // Direct Shadow Mend is deliberately last-resort triage. It is used when an
  // ally is genuinely critical, when Holy is locked, or when major burst is
  // about to land and offensive Penance cannot answer in time.
  const directMendTarget=low===u;
  const mendEmergency=(directMendTarget&&(selfHp<.66||targeted&&selfHp<.80||holyLocked&&selfHp<.84))||(!directMendTarget&&(hp<.46||holyLocked&&hp<.58||hp<.54&&burstScore>=3.2&&!penanceReady));
  if(mendEmergency&&mend>=0&&u.resource>=(AB[u.cls][mend].cost||0)){this.stopMove();this.game.tryAbility(u,mend,low);return;}

  if(u.has('radiantPenanceProc')&&atoned>=1&&penance>=0&&u.cds[penance]<=0&&target&&dist(u,target)<=25&&this.game.arena.los(u,target)){this.game.tryAbility(u,penance,target);return;}
  if(archangel>=0&&u.cds[archangel]<=0&&atoned>=1&&(hp<.84||burst||injured>=2)){this.game.tryAbility(u,archangel,u);return;}
  const coordinatedPressure=!!(target&&target===partnerTarget&&(target.hp/target.maxHp<.92||this.game.unitUnderMajorOffensive(target)));
  if(darkArch>=0&&u.cds[darkArch]<=0&&atoned>=(expert?2:1)&&target&&hp>.68&&(target.hp/target.maxHp<.84||this.game.unitUnderMajorOffensive(target)||this.enemyHealerState(enemies).locked||coordinatedPressure)){this.game.tryAbility(u,darkArch,u);return;}
  if(atoned&&canDamage){
   if(penanceReady&&(expert||hp<.96||burst||atoned>=2)){this.game.tryAbility(u,penance,target);return;}
   if(solace>=0&&u.cds[solace]<=0&&dist(u,target)<=25&&this.game.arena.los(u,target)){this.game.tryAbility(u,solace,target);return;}
   if(!repositioning&&smite>=0&&u.resource>=(AB[u.cls][smite].cost||0)&&(expert||hp<.97)){this.stopMove();this.game.tryAbility(u,smite,target);return;}
  }

  // If no hostile target can be reached, direct healing prevents a helpless
  // stall, but still waits for a real emergency instead of spamming at 86%.
  if(!canDamage&&hp<.52&&penanceReady&&dist(u,low)<=25&&this.game.arena.los(u,low)){this.game.tryAbility(u,penance,low);return;}
  if(!canDamage&&hp<.68&&mend>=0&&u.resource>=(AB[u.cls][mend].cost||0)){this.stopMove();this.game.tryAbility(u,mend,low);return;}
  const close=enemies.find(e=>e.alive&&dist(u,e)<=8&&this.game.arena.los(u,e));
  if(close&&fear>=0&&u.cds[fear]<=0&&this.ccValue(close,'fear')>0&&(targeted||selfHp<.78||this.attacking(low,close))){this.game.tryAbility(u,fear,u);return;}
  if(partner&&dist(u,partner)>22){if(angelicBody>=0&&u.cds[angelicBody]<=0)this.game.tryAbility(u,angelicBody,u);this.moveToward(partner,false);return;}
  if(repositioning)return;
  this.healerReposition(allies,enemies,low,{threat:enemies.find(e=>this.attacking(u,e))||enemies[0],d});
 }
 healer(allies,enemies,d){const u=this.u;if(this.survivorHealerDuel(allies,enemies))return;if(u.cls==='pala'){this.paladinHealer(allies,enemies,d);return;}if(u.cls==='disc'){this.disciplineHealer(allies,enemies,d);return;}if(this.antiMageHealerResponse(allies,enemies))return;const healable=allies.filter(a=>!a.has('smokeBomb'));const low=(healable.length?healable:allies).slice().sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];const hp=low.hp/low.maxHp;const stable=allies.every(a=>a.hp/a.maxHp>.73);const controlledAlly=allies.filter(a=>a!==u&&a.alive&&a.effects.some(e=>['poly','sleep','blind','windIncap','fear','root','slow'].includes(e.type))).sort((a,b)=>{const score=x=>x.has('poly')||x.has('sleep')||x.has('blind')||x.has('windIncap')||x.has('fear')?5:x.has('root')?3:1;return score(b)-score(a);})[0];const dispelTarget=allies.filter(a=>a.alive&&dist(u,a)<=28&&this.game.arena.los(u,a)&&a.effects.some(e=>['poly','sleep','blind','windIncap','fear','root','slow'].includes(e.type))).sort((a,b)=>{const score=x=>x.has('poly')||x.has('sleep')||x.has('blind')||x.has('windIncap')||x.has('fear')?5:x.has('root')?3:1;return score(b)-score(a);})[0];if(!this.game.isInCombat(u)&&!u.mounted&&!u.cast&&dist(u,low)>12&&this.game.time>u.aiMountDelay){this.game.tryMount(u,false);return;}const threats=enemies.filter(e=>e.alive).sort((a,b)=>dist(a,u)-dist(b,u));const threat=threats[0];const rangedPressure=threats.find(e=>e.alive&&((e.cast&&e.cast.target===u)||(this.attacking(u,e)&&dist(e,u)<=27&&this.game.arena.los(e,u))));const enemyHealer=enemies.find(e=>(e.cls==='sage'||e.cls==='pala'||e.cls==='disc')&&e.alive);const targeted=threats.some(e=>(e===this.game.player&&this.game.target===u)||(e.ai&&e.ai.focus===u));const peelThreat=this.peelThreat(enemies,allies,24);const danger=!!(threat&&(dist(threat,u)<9||targeted)||rangedPressure);const partnerLocked=allies.find(a=>a!==u&&a.alive&&['poly','fear','sleep','blind','windIncap','furyStun','cheapStun','stun'].some(type=>a.has(type)));const incomingCC=enemies.find(e=>e.alive&&e.cast&&e.cast.target===u&&['poly','sleep','fear'].includes(e.cast.a?.type));const swapThreat=threats.find(e=>e.alive&&!['sage','pala','disc'].includes(e.cls))||threat;const isolated=!!(partnerLocked&&swapThreat&&(targeted||dist(swapThreat,u)<18||this.attacking(u,swapThreat)||u.hp/u.maxHp<.90));const lastAlive=allies.filter(a=>a.alive).length===1;
  if(this.openerHealerSetup(allies,enemies,low))return;
  if(controlledAlly&&(!this.game.arena.los(u,controlledAlly)||dist(u,controlledAlly)>28)){if(u.cast)u.cast=null;this.moveToward(controlledAlly,false);return;}
  if(low!==u&&u.hp/u.maxHp>.46&&this.moveToHealLine(low,enemies,hp<.88||this.game.unitUnderMajorOffensive(low)||low.has('smokeBomb')))return;
  if(lastAlive){if(u.cast&&!(u.hp/u.maxHp<.62&&u.cast.a?.type==='sleep'))return;if(u.hp/u.maxHp<.36&&u.cds[3]<=0&&u.resource>=18){this.stopMove();this.game.tryAbility(u,3,u);return;}if(u.hp/u.maxHp<.64&&u.cds[2]<=0&&u.resource>=10){this.stopMove();this.game.tryAbility(u,2,u);return;}if(u.hp/u.maxHp<.78&&!u.has('hot')&&u.cds[1]<=0&&u.resource>=8){this.stopMove();this.game.tryAbility(u,1,u);return;}if(u.hp/u.maxHp<.88&&u.resource>=6){this.stopMove();this.game.tryAbility(u,0,u);return;}if(threat&&u.hp/u.maxHp>.82&&u.cds[6]<=0&&u.resource>=8&&u.cds[2]<9&&dist(u,threat)<=24&&this.game.arena.los(u,threat)&&!threat.has('sleep')&&this.ccValue(threat,'incap')>0){this.game.tryAbility(u,6,threat);this.moveToward(threat,true);return;}if(threat&&!u.cast&&dist(u,threat)>18)this.moveToward(threat,false);else this.stopMove();return;}
  if(dispelTarget&&u.cds[4]<=0&&u.resource>=5){if(this.delayedDispel(dispelTarget,4))return;if(!isolated&&u.hp/u.maxHp>.55){this.stopMove();return;}}else this.dispelDecision=null;
  if(incomingCC){if(u.cds[5]<=0&&u.resource>=6){this.game.tryAbility(u,5,u);this.moveToward(incomingCC,true);return;}if(!u.cast){this.moveToward(incomingCC,true);return;}}
  if(this.healerReposition(allies,enemies,low,{threat:rangedPressure||swapThreat||threat}))return;
  if(isolated){
   if(u.cast&&u.hp/u.maxHp<.70)u.cast=null;
   if(peelThreat&&u.cds[6]<=0&&u.resource>=8&&dist(u,peelThreat)<=24&&this.game.arena.los(u,peelThreat)&&!peelThreat.has('sleep')&&this.ccValue(peelThreat,'incap')>0){this.game.tryAbility(u,6,peelThreat);this.moveToward(peelThreat,true);return;}
   if(u.hp/u.maxHp<.72&&u.cds[3]<=0&&u.resource>=18){this.stopMove();this.game.tryAbility(u,3,u);return;}
   if(u.cds[5]<=0&&u.resource>=6){this.game.tryAbility(u,5,u);this.moveToward(swapThreat,true);return;}
   if(u.hp/u.maxHp<.86&&!u.has('hot')&&u.cds[1]<=0&&u.resource>=8){this.stopMove();this.game.tryAbility(u,1,u);return;}
   if(!u.cast){this.moveToward(swapThreat,true);return;}
  }
  if(!this.game.arena.los(u,low)||dist(u,low)>26){if(u.cast&&hp<.55)u.cast=null;if(!u.cast)this.moveToward(low,false);return;}
  const ironbark=AB[u.cls].findIndex(a=>a.name==='Ironbark');const ghanir=AB[u.cls].findIndex(a=>a.name==="G'Hanir, the Mother Tree");
  const natureSwift=AB[u.cls].findIndex(a=>a.name==='Nature Swiftness');
  const gust=AB[u.cls].findIndex(a=>a.name==='Rejuvenate');
  const majorBurst=this.game.unitUnderMajorOffensive(low)||low.has('smokeBomb')||this.game.unitUnderBurst(low)||this.enemyBurstPotential(low,enemies)>=2.5;
  if(ghanir>=0&&u.cds[ghanir]<=0&&!u.has('ghanir')&&allies.some(a=>a.has('hot'))&&(hp<.86||majorBurst)){this.stopMove();this.game.tryAbility(u,ghanir,u);return;}
  const tideReady=(u.cds[3]<=0||u.has('natureSwiftness'))&&u.resource>=18;
  const tideNeeded=hp<.36||u.has('natureSwiftness')&&(hp<.76||majorBurst)||majorBurst&&hp<.54;
  if(majorBurst&&hp<.86&&ironbark>=0&&u.cds[ironbark]<=0&&u.resource>=(AB[u.cls][ironbark].cost||0)){this.stopMove();this.game.tryAbility(u,ironbark,low);return;}
  if(tideNeeded&&tideReady){this.stopMove();this.game.tryAbility(u,3,low);return;}
  if((hp<.50||majorBurst&&hp<.80||low.has('smokeBomb')&&hp<.86)&&u.cds[3]>1.0&&natureSwift>=0&&u.cds[natureSwift]<=0){
   this.stopMove();this.game.tryAbility(u,natureSwift,u);return;
  }
  const proactiveHeal=low&&low.alive&&low!==u&&hp<.94&&dist(u,low)<=28&&this.game.arena.los(u,low);
  if(proactiveHeal&&!danger&&!partnerLocked){
   if(hp<.92&&!this.hasNamedHot(low,'Rejuvenate',2.5)&&gust>=0&&u.cds[gust]<=0&&u.resource>=(AB[u.cls][gust].cost||0)){this.stopMove();this.game.tryAbility(u,gust,low);return;}
   if(hp<.90&&!this.hasNamedHot(low,'Blooming Echo',2.5)&&u.cds[1]<=0&&u.resource>=8){this.stopMove();this.game.tryAbility(u,1,low);return;}
   if(hp<.86&&u.resource>=6&&!u.cast){this.stopMove();this.game.tryAbility(u,0,low);return;}
  }
  if(hp<.64&&u.cds[2]<=0&&u.resource>=10){this.stopMove();this.game.tryAbility(u,2,low);return;}
  if(danger&&u.cds[5]<=0&&(u.hp/u.maxHp<.78||dist(threat,u)<6)){this.game.tryAbility(u,5,u);return;}
  if((danger||peelThreat)&&hp>.45&&u.cds[6]<=0&&u.resource>=8&&u.cds[2]<9&&dist(u,peelThreat||threat)<=24&&this.game.arena.los(u,peelThreat||threat)&&!(peelThreat||threat).has('poly')&&!(peelThreat||threat).has('sleep')&&this.ccValue(peelThreat||threat,'incap')>0){const ccT=peelThreat||threat;this.game.tryAbility(u,6,ccT);this.moveToward(ccT,true);return;}
  if(hp<.70&&!this.hasNamedHot(low,'Rejuvenate',1.5)&&gust>=0&&u.cds[gust]<=0&&u.resource>=(AB[u.cls][gust].cost||0)){this.stopMove();this.game.tryAbility(u,gust,low);return;}
  if(hp<.68&&!this.hasNamedHot(low,'Blooming Echo',1.5)&&u.cds[1]<=0&&u.resource>=8){this.stopMove();this.game.tryAbility(u,1,low);return;}
  if(hp<.78&&u.resource>=6){
   const kicker=this.interruptThreat(enemies);
   if(kicker&&hp>.62){
    if(u.cds[1]<=0&&u.resource>=8&&!this.hasNamedHot(low,'Blooming Echo',1.5)){this.stopMove();this.game.tryAbility(u,1,low);return;}
    if(u.cds[2]<=0&&u.resource>=10){this.stopMove();this.game.tryAbility(u,2,low);return;}
    if(!u.cast){this.moveToward(kicker,true);return;}
   }
   this.stopMove();this.game.tryAbility(u,0,low);return;}
  const grasp=AB[u.cls].findIndex(a=>a.name==='Nature’s Grasp'||a.name==="Nature's Grasp");
  if(stable&&enemyHealer&&grasp>=0&&u.cds[grasp]<=0&&dist(u,enemyHealer)<=24&&this.game.arena.los(u,enemyHealer)&&this.ccValue(enemyHealer,'root')>0&&!this.hasSetupCC(enemyHealer)){this.stopMove();this.game.tryAbility(u,grasp,enemyHealer);return;}
  if(stable&&enemyHealer&&u.cds[6]<=0&&u.resource>=8&&u.cds[2]<9&&dist(u,enemyHealer)<=24&&this.game.arena.los(u,enemyHealer)&&!enemyHealer.has('poly')&&!enemyHealer.has('sleep')&&this.ccValue(enemyHealer,'incap')>0){this.game.tryAbility(u,6,enemyHealer);this.moveToward(enemyHealer,false);return;}
  if(danger){if(u.cast&&u.hp/u.maxHp<.74)u.cast=null;if(!u.cast)this.moveToward(threat,true);}
  else if(!danger){this.stopMove();}
 }
}

class AudioManager {
 constructor(){
  this.ctx=null;
  this.master=null;
  this.dry=null;
  this.wet=null;
  this.enabled=localStorage.getItem('aetherSound')!=='0';
  this.volume=Number(localStorage.getItem('aetherVolume')||0.34);
  this.lastImpact=0;this.externalBuffers={};
  this.footstepDistance=.55;this.lastFootstepIndex=-1;this.footstepVoices=[];
  this.sampleConfig=window.AETHER_COMBAT_SOUNDS||{};this.sampleVoices=[];this.samplePreloads=[];
  this.lastSampleAt={};this.lastSampleIndex={};this.samplesPreloaded=false;
  this.eventGain=1;this.spatialRadius=12;this.spatialFullVolumeRadius=5;this.spatialDepth=0;this.recentCombatSource=null;this.recentCombatSourceUntil=0;
 }
 ensure(){
  if(!this.enabled)return;
  const Ctx=window.AudioContext||window.webkitAudioContext;
  if(!Ctx)return;
  if(!this.ctx){
   this.ctx=new Ctx();
   this.master=this.ctx.createGain();
   this.master.gain.value=this.volume;
   const compressor=this.ctx.createDynamicsCompressor();
   compressor.threshold.value=-22; compressor.knee.value=24;
   compressor.ratio.value=5; compressor.attack.value=.004; compressor.release.value=.18;
   this.dry=this.ctx.createGain(); this.dry.gain.value=.92;
   this.wet=this.ctx.createGain(); this.wet.gain.value=.22;
   const convolver=this.ctx.createConvolver();
   convolver.buffer=this.makeImpulse(1.15,1.7);
   this.dry.connect(this.master);
   this.wet.connect(convolver).connect(this.master);
   this.master.connect(compressor).connect(this.ctx.destination);
  }
  if(this.ctx.state==='suspended')this.ctx.resume();
  this.preloadSamples();
 }
 makeImpulse(seconds,decay){
  const length=Math.floor(this.ctx.sampleRate*seconds);
  const impulse=this.ctx.createBuffer(2,length,this.ctx.sampleRate);
  for(let c=0;c<2;c++){
   const channel=impulse.getChannelData(c);
   for(let i=0;i<length;i++){
    const fall=Math.pow(1-i/length,decay);
    channel[i]=(Math.random()*2-1)*fall*(c?0.94:1);
   }
  }
  return impulse;
 }
 setEnabled(v){
  this.enabled=v; localStorage.setItem('aetherSound',v?'1':'0');
  if(!v){[...this.footstepVoices,...this.sampleVoices].forEach(voice=>{try{voice.pause();}catch(e){}});this.footstepVoices=[];this.sampleVoices=[];}
  if(v){this.ensure();this.play('menu');}
 }
 setVolume(v){
  this.volume=clamp(v,0,1); localStorage.setItem('aetherVolume',String(this.volume));
  if(this.master)this.master.gain.setTargetAtTime(this.volume,this.ctx.currentTime,.025);
  this.footstepVoices.forEach(voice=>{voice.volume=clamp(this.volume*.30,0,.34);});
  this.sampleVoices.forEach(voice=>{voice.volume=clamp(this.volume*(voice._aetherGain||.5),0,1);});
  if(this.enabled){this.ensure();this.chime(520,.10,.08,0);}
 }
 preloadSamples(){
  if(this.samplesPreloaded)return;this.samplesPreloaded=true;
  Object.values(this.sampleConfig).forEach(group=>(group.files||[]).forEach(file=>{const audio=new Audio(`audio/combat/${file}`);audio.preload='auto';this.samplePreloads.push(audio);try{audio.load();}catch(e){}}));
 }
 spatialGain(source){
  if(!source)return 1;
  const listener=source.game?.player;
  if(!listener||source===listener)return 1;
  const sx=Number(source.x??source.mesh?.position?.x),sz=Number(source.z??source.mesh?.position?.z);
  const lx=Number(listener.x??listener.mesh?.position?.x),lz=Number(listener.z??listener.mesh?.position?.z);
  if(![sx,sz,lx,lz].every(Number.isFinite))return 1;
  const distance=Math.hypot(sx-lx,sz-lz);
  if(distance>=this.spatialRadius)return 0;
  if(distance<=this.spatialFullVolumeRadius)return 1;
  return clamp(1-(distance-this.spatialFullVolumeRadius)/(this.spatialRadius-this.spatialFullVolumeRadius),0,1);
 }
 withSpatial(source,callback){
  const gain=this.spatialGain(source);if(gain<=0)return false;
  const previous=this.eventGain;this.eventGain=previous*gain;this.spatialDepth++;
  try{return callback();}finally{this.spatialDepth--;this.eventGain=previous;}
 }
 playSample(groupName,options={}){
  if(groupName==='fire_impact'&&performance.now()<(this.volcanicSoundUntil||0))groupName='volcanic_eruption';
  if(!options.source&&!this.spatialDepth&&this.recentCombatSource&&performance.now()<this.recentCombatSourceUntil)return this.playSample(groupName,{...options,source:this.recentCombatSource});
  if(options.source){const {source,...rest}=options;return this.withSpatial(source,()=>this.playSample(groupName,rest));}
  if(!this.enabled)return true;
  const group=this.sampleConfig[groupName];if(!group||!group.files?.length)return false;
  const now=performance.now(),cooldown=Number(options.cooldown??group.cooldown??0);
  if(now-(this.lastSampleAt[groupName]||0)<cooldown)return true;
  this.lastSampleAt[groupName]=now;
  let index=Math.floor(Math.random()*group.files.length),last=this.lastSampleIndex[groupName];
  if(group.files.length>1&&index===last)index=(index+1+Math.floor(Math.random()*(group.files.length-1)))%group.files.length;
  this.lastSampleIndex[groupName]=index;
  const chosenRate=options.rate??group.rate??[1,1],range=Array.isArray(chosenRate)?chosenRate:[Number(chosenRate)||1,Number(chosenRate)||1];
  const voice=new Audio(`audio/combat/${group.files[index]}`),gain=Number(options.gain??group.gain??.5)*(this.eventGain||1);
  voice.preload='auto';voice._aetherGain=gain;voice.volume=clamp(this.volume*gain,0,1);voice.playbackRate=range[0]+Math.random()*Math.max(0,range[1]-range[0]);
  this.sampleVoices=this.sampleVoices.filter(item=>!item.ended&&!item.paused);
  while(this.sampleVoices.length>=14){const old=this.sampleVoices.shift();try{old.pause();}catch(e){}}
  this.sampleVoices.push(voice);voice.onended=()=>{this.sampleVoices=this.sampleVoices.filter(item=>item!==voice);};
  const started=voice.play();if(started?.catch)started.catch(()=>{});return true;
 }
 playHurt(amount,maxHp){if(Number(amount)>=(Number(maxHp)||1)*.055)this.playSample('hurt');}
 updateFootsteps(unit,moving,frameDistance){
  const grounded=(unit?.jumpY||0)<=.001&&Math.abs(unit?.jumpVel||0)<.01;
  const onFoot=!unit?.mounted&&!unit?.has?.('divineSteed');
  const inMatch=unit?.game?.phase==='fight';
  if(!this.enabled||!unit?.isPlayer||!moving||!grounded||!onFoot||!inMatch){this.footstepDistance=.55;return;}
  this.footstepDistance+=clamp(Number(frameDistance)||0,0,.45);
  const stride=clamp(1.72-(Math.max(3,unit.moveSpeed||5)-5)*.045,1.38,1.78);
  if(this.footstepDistance>=stride){this.footstepDistance%=stride;this.playFootstep();}
 }
 playFootstep(){
  if(!this.enabled)return;
  let index=Math.floor(Math.random()*8);
  if(index===this.lastFootstepIndex)index=(index+1+Math.floor(Math.random()*7))%8;
  this.lastFootstepIndex=index;
  const voice=new Audio(`audio/footsteps/step_${String(index+1).padStart(2,'0')}.mp3`);
  voice.preload='auto';voice.volume=clamp(this.volume*.30,0,.34);voice.playbackRate=.94+Math.random()*.12;
  this.footstepVoices=this.footstepVoices.filter(item=>!item.ended&&!item.paused);
  while(this.footstepVoices.length>=3){const old=this.footstepVoices.shift();try{old.pause();}catch(e){}}
  this.footstepVoices.push(voice);
  const started=voice.play();if(started?.catch)started.catch(()=>{});
 }
 route(node,wet=.18){
  if(!this.ctx)return;
  const direct=this.ctx.createGain(), ambience=this.ctx.createGain();
  direct.gain.value=1; ambience.gain.value=wet;
  node.connect(direct).connect(this.dry);
  node.connect(ambience).connect(this.wet);
 }
 osc(freq,endFreq,duration,type='sine',volume=.12,delay=0,filterFreq=2600,wet=.16){
  if(!this.enabled)return;
  volume*=this.eventGain||1;if(volume<=.0001)return;
  this.ensure(); if(!this.ctx)return;
  const at=this.ctx.currentTime+delay;
  const o=this.ctx.createOscillator(), filter=this.ctx.createBiquadFilter(), g=this.ctx.createGain();
  o.type=type; o.frequency.setValueAtTime(freq,at);
  o.frequency.exponentialRampToValueAtTime(Math.max(24,endFreq||freq),at+duration);
  filter.type='lowpass';filter.frequency.value=filterFreq;filter.Q.value=.3;
  g.gain.setValueAtTime(.0001,at);
  g.gain.exponentialRampToValueAtTime(Math.max(.0001,volume),at+.018);
  g.gain.exponentialRampToValueAtTime(.0001,at+duration);
  o.connect(filter).connect(g); this.route(g,wet);
  o.start(at);o.stop(at+duration+.03);
 }
 filteredNoise(duration=.12,volume=.08,type='bandpass',freq=1000,q=.7,delay=0,wet=.1){
  if(!this.enabled)return;
  volume*=this.eventGain||1;if(volume<=.0001)return;
  this.ensure(); if(!this.ctx)return;
  const at=this.ctx.currentTime+delay, length=Math.floor(this.ctx.sampleRate*duration);
  const buffer=this.ctx.createBuffer(1,length,this.ctx.sampleRate), data=buffer.getChannelData(0);
  for(let i=0;i<length;i++){const env=Math.sin(Math.PI*i/length);data[i]=(Math.random()*2-1)*env;}
  const src=this.ctx.createBufferSource(), filter=this.ctx.createBiquadFilter(), g=this.ctx.createGain();
  src.buffer=buffer; filter.type=type;filter.frequency.value=freq;filter.Q.value=q;
  g.gain.setValueAtTime(.0001,at);g.gain.exponentialRampToValueAtTime(volume,at+.012);g.gain.exponentialRampToValueAtTime(.0001,at+duration);
  src.connect(filter).connect(g);this.route(g,wet);
  src.start(at);src.stop(at+duration+.02);
 }
 chime(freq,duration=.18,volume=.10,delay=0){
  this.osc(freq,freq*.985,duration,'sine',volume,delay,5000,.38);
  this.osc(freq*2.01,freq*1.97,duration*.7,'sine',volume*.32,delay+.008,6500,.42);
 }
 whoosh(low,high,duration=.16,volume=.08,delay=0){
  this.filteredNoise(duration,volume,'bandpass',high,1.1,delay,.16);
  this.osc(low,high,duration,'triangle',volume*.5,delay,2100,.2);
 }
 playExternal(name){
  // Optional local asset hook. If files are added later under ./assets/sfx/<name>.mp3 or .wav,
  // the game will use them; otherwise the WebAudio fantasy fallback plays.
  if(!this.enabled||!this.ctx)return false;
  const srcs=[`assets/sfx/${name}.mp3`,`assets/sfx/${name}.wav`];
  const cached=this.externalBuffers[name];
  if(cached&&cached.buffer){const s=this.ctx.createBufferSource();s.buffer=cached.buffer;const g=this.ctx.createGain();g.gain.value=.85;s.connect(g);this.route(g,.22);s.start();return true;}
  if(cached&&cached.loading)return false;
  this.externalBuffers[name]={loading:true};
  const tryFetch=async()=>{
   for(const url of srcs){
    try{
     const r=await fetch(url);
     if(!r.ok)continue;
     const arr=await r.arrayBuffer();
     const buf=await this.ctx.decodeAudioData(arr);
     this.externalBuffers[name]={buffer:buf};
     return;
    }catch(e){}
   }
   this.externalBuffers[name]={missing:true};
  };
  tryFetch();
  return false;
 }
 play(name,source=null){
  if(!source&&!this.spatialDepth&&this.recentCombatSource&&performance.now()<this.recentCombatSourceUntil)source=this.recentCombatSource;
  if(source)return this.withSpatial(source,()=>this.play(name));
  if(!this.enabled)return;
  switch(name){
   case 'menu': this.chime(392,.16,.085); this.chime(587,.23,.06,.07); break;
   case 'start':
    this.osc(98,145,.34,'sine',.13,0,850,.32);
    this.chime(392,.20,.09,.10); this.chime(784,.32,.095,.24); break;
   case 'cast':
    this.osc(178,252,.20,'sine',.035,0,1000,.24);
    this.chime(640,.10,.028,.05); break;
   case 'mountSummon':
    this.whoosh(92,340,.34,.09,0); this.chime(294,.18,.07,.04); this.chime(440,.26,.055,.14); break;
   case 'mountReady':
    this.osc(82,118,.24,'triangle',.105,0,680,.28); this.filteredNoise(.13,.07,'bandpass',720,1.1,.03,.18); this.chime(523,.18,.08,.12); this.chime(784,.28,.065,.19); break;
   case 'fire':
    if(this.playSample('fire_cast'))break;
    this.whoosh(110,530,.18,.13);
    this.filteredNoise(.17,.06,'lowpass',850,.3,.02,.18);
    this.osc(94,62,.20,'sine',.085,.03,420,.15); break;
   case 'lightning':
    if(this.playSample('lightning_cast'))break;
    this.filteredNoise(.045,.10,'highpass',3400,.35,0,.12);
    this.filteredNoise(.07,.07,'bandpass',1900,2,.025,.16);
    this.osc(720,260,.09,'triangle',.08,.005,3800,.18); break;
   case 'wind':
    this.whoosh(180,980,.18,.09);this.chime(440,.12,.046,.02);this.filteredNoise(.08,.038,'highpass',2200,.3,.03,.16);break;
   case 'shadow':
    if(this.playSample('dark_debuff'))break;
    this.whoosh(78,260,.15,.08);
    this.osc(72,49,.18,'sine',.11,.02,350,.22);
    this.filteredNoise(.08,.045,'lowpass',470,.6,.05,.12); break;
   case 'heal':
    this.chime(523,.25,.075);
    this.chime(659,.26,.055,.05);
    this.chime(988,.32,.045,.11); break;
   case 'shield':
    if(this.playSample('magic_buff'))break;
    this.osc(190,305,.28,'sine',.075,0,1400,.38);
    this.chime(760,.24,.05,.04);
    this.filteredNoise(.20,.025,'lowpass',1100,.4,0,.35); break;
   case 'dash':
    this.whoosh(130,980,.17,.11);
    this.filteredNoise(.09,.04,'highpass',2400,.3,.01,.12); break;
   case 'poly':
    this.chime(880,.16,.09);
    this.chime(1174,.22,.08,.07);
    this.chime(1568,.34,.055,.16); break;
   case 'root':
    if(this.playSample('ice_impact'))break;
    this.filteredNoise(.18,.055,'lowpass',340,.5,0,.24);
    this.osc(92,54,.28,'sine',.085,0,390,.25);
    this.osc(138,98,.18,'triangle',.04,.04,480,.22); break;
   case 'rootLegacy':
    this.filteredNoise(.14,.04,'lowpass',360,.5,0,.20);this.osc(96,58,.22,'sine',.06,0,420,.20);this.osc(142,102,.15,'triangle',.03,.035,520,.18);break;
   case 'stun':
    this.filteredNoise(.07,.13,'lowpass',720,.4,0,.12);
    this.osc(70,42,.22,'sine',.14,0,280,.2);
    this.osc(190,105,.10,'triangle',.06,0,760,.1); break;
   case 'interrupt':
    this.filteredNoise(.06,.11,'bandpass',2200,1.8,0,.12);
    this.osc(1120,320,.13,'triangle',.095,0,4200,.15);
    this.chime(1240,.07,.04,.01); break;
   case 'proc':
    this.playSample('rune_activate',{gain:.34});this.chime(587,.15,.08); this.chime(880,.22,.08,.06);this.chime(1174,.30,.06,.12);break;
   case 'holy':
    if(this.playSample('holy_blessing'))break;
    this.chime(523,.14,.065);this.chime(784,.22,.052,.04);this.osc(310,470,.17,'sine',.035,0,1600,.25);break;
   case 'infusion':
    this.playSample('holy_blessing',{gain:.42});this.chime(659,.16,.10);this.chime(988,.24,.10,.055);this.chime(1318,.38,.085,.14);this.chime(1760,.42,.045,.23);break;
   case 'furyTick':
    this.whoosh(115,640,.10,.075);this.filteredNoise(.065,.088,'bandpass',930,1.1,0,.08);this.osc(84,52,.095,'sine',.105,.006,290,.10);break;
   case 'siphonTick':
    this.whoosh(340,82,.16,.055);this.osc(185,74,.18,'sine',.095,0,760,.26);this.chime(466,.11,.035,.025);break;
   case 'meteorImpact':
    this.playSample('fire_impact',{gain:.78,cooldown:0});this.filteredNoise(.36,.19,'lowpass',420,.32,0,.38);this.filteredNoise(.16,.12,'bandpass',1200,.7,.015,.24);this.osc(58,32,.50,'sine',.22,0,170,.40);this.osc(142,48,.28,'sawtooth',.10,.018,440,.22);break;
   case 'fireBurst':
    this.playSample('fire_impact',{gain:.70});this.whoosh(150,900,.22,.15);this.filteredNoise(.18,.09,'lowpass',680,.42,.02,.18);this.osc(78,42,.28,'sawtooth',.10,.02,360,.20);break;
   case 'fireShield':
    this.playSample('magic_buff',{gain:.46});this.osc(110,160,.20,'triangle',.08,0,900,.25);this.filteredNoise(.18,.055,'lowpass',760,.35,.02,.18);this.chime(392,.12,.04,.06);break;
   case 'natureHeal':
    this.chime(440,.18,.07);this.chime(659,.28,.055,.06);this.filteredNoise(.16,.035,'highpass',1800,.25,.02,.28);break;
   case 'bigNature':
    this.chime(392,.22,.08);this.chime(523,.24,.08,.06);this.chime(784,.36,.07,.14);this.filteredNoise(.24,.035,'bandpass',1500,.7,.04,.32);break;
   case 'cleanse':
    if(this.playSample('magic_buff'))break;this.chime(880,.12,.09);this.filteredNoise(.08,.04,'highpass',3200,.28,.02,.18);this.chime(1320,.18,.05,.08);break;
   case 'holyShock':
    this.playSample('magic_launch',{gain:.48});this.chime(784,.10,.07);this.chime(1174,.18,.05,.05);break;
   case 'sacrifice':
    this.playSample('holy_blessing',{gain:.56});this.osc(174,220,.25,'triangle',.06,0,1000,.35);this.chime(523,.22,.05,.04);break;
   case 'windChi':
    this.whoosh(260,1450,.13,.08);this.chime(880,.12,.055,.02);this.chime(660,.18,.04,.07);break;
   case 'willow':
    this.chime(392,.22,.08);this.chime(587,.24,.065,.06);this.filteredNoise(.22,.045,'bandpass',1200,.8,.02,.34);break;
   case 'fists':
    this.whoosh(120,860,.12,.10);this.filteredNoise(.09,.085,'bandpass',1050,1.1,0,.10);this.osc(92,58,.10,'sine',.11,.005,320,.10);break;
   case 'soulFear':
    this.osc(160,54,.34,'sine',.13,0,520,.38);this.filteredNoise(.20,.052,'lowpass',420,.8,.02,.30);this.chime(311,.18,.045,.06);break;
   case 'soulBloom':
    this.osc(95,170,.22,'triangle',.08,0,660,.30);this.filteredNoise(.16,.065,'bandpass',900,.9,.02,.22);this.chime(466,.16,.045,.04);break;
   case 'stormShield':
    this.playSample('magic_buff',{gain:.46});this.filteredNoise(.08,.07,'highpass',3000,.35,0,.14);this.osc(220,110,.20,'triangle',.06,.01,1400,.28);break;
   case 'warriorBlade':
    if(this.playSample('heavy_whoosh'))break;this.filteredNoise(.075,.18,'highpass',4200,1.0,0,.08);this.filteredNoise(.10,.12,'bandpass',930,2.4,.018,.08);this.osc(170,62,.16,'triangle',.13,0,780,.10);this.chime(740,.055,.045,.02);break;
   case 'rogueSteel':
    if(this.playSample('fast_swing'))break;this.filteredNoise(.040,.16,'highpass',5600,.75,0,.06);this.osc(1320,420,.070,'triangle',.075,.005,5200,.07);this.filteredNoise(.045,.08,'bandpass',1700,1.8,.018,.08);break;
   case 'stormCrackle':
    if(this.playSample('lightning_cast'))break;this.filteredNoise(.055,.20,'highpass',6400,.20,0,.10);this.filteredNoise(.085,.12,'bandpass',2600,2.4,.02,.13);this.osc(980,260,.095,'square',.09,.006,5200,.12);this.chime(1480,.06,.04,.02);break;
   case 'stormLegacy':
    this.filteredNoise(.045,.105,'highpass',5200,.24,0,.09);this.filteredNoise(.07,.065,'bandpass',2300,1.8,.02,.11);this.osc(880,240,.10,'triangle',.055,.006,4400,.11);break;
   case 'flameMage':
    if(this.playSample('fire_cast'))break;this.whoosh(105,950,.23,.18);this.filteredNoise(.20,.13,'lowpass',760,.25,.015,.18);this.osc(88,38,.26,'sawtooth',.13,.02,360,.16);this.chime(440,.09,.035,.08);break;
   case 'flameLegacy':
    this.whoosh(105,950,.23,.13);this.filteredNoise(.20,.095,'lowpass',760,.25,.015,.18);this.osc(88,38,.26,'sawtooth',.10,.02,360,.16);this.chime(440,.09,.028,.08);break;
   case 'fireBurstLegacy':
    this.whoosh(150,900,.22,.13);this.filteredNoise(.18,.075,'lowpass',680,.42,.02,.18);this.osc(78,42,.28,'sawtooth',.085,.02,360,.20);break;
   case 'fireImpactLegacy':
    this.filteredNoise(.09,.075,'bandpass',1120,.75,0,.11);this.osc(112,52,.14,'sawtooth',.07,0,520,.14);break;
   case 'discBolt':
    this.osc(420,690,.12,'sine',.045,0,2400,.22);this.chime(880,.13,.045,.025);this.filteredNoise(.055,.024,'highpass',3100,.28,.015,.12);break;
   case 'discSmite':
    this.osc(540,1080,.10,'triangle',.050,0,3600,.16);this.chime(1080,.10,.040,.018);break;
   case 'discSolace':
    this.chime(494,.22,.060);this.chime(659,.28,.044,.055);this.osc(220,330,.24,'sine',.035,0,1200,.30);break;
   case 'discPenance':
    this.osc(780,1180,.13,'sine',.043,0,4200,.22);this.chime(1480,.11,.032,.022);this.filteredNoise(.045,.018,'highpass',3800,.25,.012,.12);break;
   case 'windMonk':
    if(this.playExternal('wind_monk'))break;this.whoosh(260,1500,.16,.13);this.filteredNoise(.080,.12,'bandpass',1180,1.4,0,.09);this.osc(190,62,.11,'triangle',.11,.006,700,.08);this.chime(880,.07,.045,.03);break;
   case 'soulVoid':
    if(this.playSample('dark_debuff'))break;this.osc(70,32,.36,'sine',.18,0,330,.34);this.filteredNoise(.20,.09,'lowpass',390,1.1,.02,.30);this.chime(233,.18,.05,.06);this.chime(466,.16,.035,.12);break;
   case 'shadowLegacy':
    this.whoosh(78,260,.15,.055);this.osc(72,49,.18,'sine',.08,.02,350,.22);this.filteredNoise(.08,.032,'lowpass',470,.6,.05,.12);break;
   case 'wardLegacy':
    this.osc(190,305,.28,'sine',.055,0,1400,.32);this.chime(760,.21,.038,.04);this.filteredNoise(.16,.020,'lowpass',1100,.4,0,.30);break;
   case 'sageBloom':
    if(this.playExternal('sage_bloom'))break;this.chime(392,.20,.095);this.chime(587,.28,.075,.06);this.chime(784,.36,.055,.15);this.filteredNoise(.24,.055,'highpass',1750,.32,.02,.34);break;
   case 'paladinBell':
    if(this.playSample('holy_blessing'))break;this.chime(523,.18,.11);this.chime(784,.30,.095,.045);this.chime(1046,.34,.070,.13);this.osc(270,520,.22,'sine',.055,0,1600,.28);break;
   case 'iceCast': if(this.playSample('ice_cast'))break;this.play('root');break;
   case 'iceImpact': if(this.playSample('ice_impact'))break;this.play('root');break;
   case 'magicLaunch': if(this.playSample('magic_launch'))break;this.play('cast');break;
   case 'magicBuff': if(this.playSample('magic_buff'))break;this.play('shield');break;
   case 'potion': if(this.playSample('potion'))break;this.play('heal');break;
   case 'rune': if(this.playSample('rune_activate'))break;this.play('proc');break;
   case 'death':
    this.osc(150,52,.46,'sine',.13,0,520,.3);
    this.filteredNoise(.29,.052,'lowpass',300,.5,.03,.26); break;
   case 'victory':
    this.chime(392,.22,.10);this.chime(523,.24,.095,.12);this.chime(784,.46,.11,.26);break;
   case 'achievement':
    this.chime(523,.16,.09);this.chime(784,.18,.09,.07);this.chime(1046,.26,.08,.13);this.chime(1568,.44,.06,.24);break;
   case 'defeat':
    this.osc(280,196,.28,'sine',.11,0,700,.35);
    this.osc(196,82,.43,'sine',.12,.18,520,.38);break;
  }
 }
 playImpact(label='',source=null,target=null){return this.withSpatial(target||source,()=>this.playImpactUnspatial(label));}
 playImpactUnspatial(label=''){
  if(!this.enabled)return;
  if(/\bTick\b/i.test(label))return;
  const now=performance.now(); if(now-this.lastImpact<55)return;this.lastImpact=now;
  const name=String(label||'');
  if(/Tick|Burn|Poison|Bleed|Torment|Affliction|Soul Scar|Agony|Flame Shock|Karma|Trail|Essence Siphon/i.test(name))return;
  if(/Gushing Wound|Warbreaker|Rising Sun Kick|Eviscerate/i.test(name)){this.playSample('finisher');return;}
  if(/Cinder Bolt/i.test(name)){this.playSample('fire_impact');return;}
  if(/Ember Lance|Meteorfall|Living Bomb|Lava Burst|Dragon Breath|Fire Shield/i.test(name)){this.play('fireImpactLegacy');return;}
  if(/Frostfire|Ice Nova/i.test(name)){this.playSample('ice_impact');return;}
  if(/Mortal Swing|Charge|Pummel|Victory Rush|Execute/i.test(name)){this.playSample('warrior_hit');return;}
  if(/Night Slash|Viper Cut|Ribbreaker|Garrote|Shadow Kick|Shiv|Internal Bleeding/i.test(name)){this.playSample('dagger_hit');return;}
  if(/Valley Sweep/i.test(name)){this.playSample('heavy_whoosh',{gain:.54,rate:1.12});return;}
  if(/Zephyr Palm/i.test(name)){this.playSample('fast_swing',{gain:.32,rate:1.18});return;}
  if(/Cloudstep|Dawncrest/i.test(name)){this.playSample('finisher',{gain:.46,rate:.88});return;}
  if(/Cyclone Barrage|Disrupting Palm|Righteous Strike/i.test(name)){this.playSample('sword_hit');return;}
  if(/Smite/i.test(name)){this.play('discSmite');return;}
  if(/Solace/i.test(name)){this.play('discSolace');return;}
  if(/Penance/i.test(name)){this.play('discPenance');return;}
  if(/Cinder|Ember|Burn/i.test(name)){this.filteredNoise(.065,.045,'lowpass',820,.4,0,.1);this.osc(92,58,.09,'sine',.042,0,340,.12);}
  else if(/Arc|Forked|Skybreaker/i.test(name)){this.filteredNoise(.04,.062,'highpass',2900,.35,0,.08);}
  else if(/Slash|Viper|Binding|Ribbreaker/i.test(name)){this.filteredNoise(.045,.052,'bandpass',760,.9,0,.06);}
  else {this.filteredNoise(.04,.032,'lowpass',620,.4,0,.05);}
 }
 playAbility(a,c=null){this.recentCombatSource=c;this.recentCombatSourceUntil=performance.now()+50;if(a?.name==='Volcanic Eruption')this.volcanicSoundUntil=performance.now()+180;return this.withSpatial(c,()=>this.playAbilityUnspatial(a,c));}
 playAbilityUnspatial(a,c=null){
  const n=a?.name||'',t=a?.type||'',s=a?.school||'',cls=c?.cls||'';
  if(t==='vendetta'||/Vendetta/i.test(n))return;
  if(/Volcanic Eruption/i.test(n)||t==='volcanicEruption')return this.playSample('volcanic_eruption',{gain:.78,rate:.88,cooldown:160});
  if(cls==='sage'){
   if(/Verdant Mend/i.test(n)||t==='heal')return this.playSample('holy_blessing',{gain:.40});
   if(/Blooming Echo|Rejuvenate/i.test(n)||t==='hot')return this.playSample('magic_buff',{gain:.36,rate:.96});
   if(/Spirit Blossom/i.test(n)||t==='spiritBlossom')return this.playSample('rune_activate',{gain:.53,rate:1.04});
   if(/Renewal Tide/i.test(n)||t==='bigHeal')return this.playSample('holy_blessing',{gain:.62,rate:.92,cooldown:0});
   if(/Purifying Light/i.test(n)||t==='cleanse')return this.playSample('magic_buff',{gain:.48,rate:1.08});
   if(/Fae Retreat/i.test(n)||t==='healerEscape')return this.playSample('magic_launch',{gain:.34,rate:1.12});
   if(/Nature’s Grasp/i.test(n)||t==='root')return this.playSample('ice_cast',{gain:.34,rate:.88});
   if(/Ironbark/i.test(n)||t==='ironbark')return this.playSample('magic_buff',{gain:.52,rate:.88});
   if(/Nature Swiftness|G'Hanir/i.test(n)||['natureSwiftness','ghanir'].includes(t))return this.playSample('rune_activate',{gain:.60,rate:.94,cooldown:0});
   if(/Lullaby Bloom/i.test(n)||t==='sleep')return this.playSample('dark_debuff',{gain:.32,rate:1.10});
   return this.playSample('holy_blessing',{gain:.38});
  }
  if(/Blazing Step/i.test(n))return this.play('dash');
  if(/Crimson Vial/i.test(n))return this.play('potion');
  if(/Ice Block/i.test(n)||t==='iceBlock')return this.play('iceCast');
  if(/Frostfire Nova|Ice Nova/i.test(n)||t==='flameNova')return this.play('iceImpact');
  if(cls==='shadow'&&(/Night Slash|Viper Cut|Ribbreaker|Shadow Kick|Garrote|Shiv|Umbral Pounce/i.test(n)||['damage','dot','leap','singleStun','shadowInterrupt','shiv'].includes(t)))return this.play('rogueSteel');
  if(/Smoke Bomb|Cloak of Shadows/i.test(n)||t==='cloak')return this.play('soulVoid');
  if(cls==='disc'&&(/Smite/i.test(n)||t==='discSmite'))return this.play('discSmite');
  if(cls==='disc'&&(/Solace/i.test(n)||t==='discSolace'))return this.play('discSolace');
  if(cls==='disc'&&(/Penance/i.test(n)||t==='discPenance'))return this.play('discPenance');
  if(/Mortal Horror|Fear/i.test(n)||t==='fear')return this.play('soulFear');
  if(cls==='wind'&&(/Incapacitate/i.test(n)||t==='windIncap'))return this.playSample('dark_debuff',{gain:.38,rate:1.18,cooldown:210});
  if(/Lullaby|Blind|Prism Hex/i.test(n)||['poly','blind','sleep'].includes(t))return this.play(cls==='shadow'?'rogueSteel':'poly');
  if(/Holy Shock/i.test(n)||t==='holyShock')return this.play('holyShock');
  if(/Sacrifice/i.test(n)||t==='sacrifice')return this.play('sacrifice');
  if(/Cleanse|Purifying/i.test(n)||t==='cleanse')return this.play('cleanse');
  if(/Blessing of Freedom|Divine Protection|Guardian Angel|Power Shield|Pain Suppression|Fade/i.test(n)||['discShield','painSuppression','discFade'].includes(t))return this.play('magicBuff');
  if(cls==='pala'||s==='holy'||['holyLight','paladinAoE','paladinGuard','paladinStun'].includes(t))return this.play(t==='holyLight'||t==='paladinAoE'?'paladinBell':'holy');
  if(/Willow Guard/i.test(n)||t==='monkDefensive')return this.playSample('magic_buff',{gain:.54,rate:.86,cooldown:220});
  if(/Tigereye Brew/i.test(n)||t==='tigereyeBrew')return this.playSample('potion',{gain:.52,rate:1.08,cooldown:180});
  if(/Fists of Fury/i.test(n)||t==='fistsChannel')return this.play('fists');
  if(/Valley Sweep/i.test(n))return this.playSample('heavy_whoosh',{gain:.52,rate:1.12,cooldown:220});
  if(/Tiger's Lust/i.test(n)||t==='tigersLust')return this.playSample('rune_activate',{gain:.46,rate:1.12,cooldown:220});
  if(/Disabling Reach/i.test(n))return this.playSample('magic_launch',{gain:.42,rate:.92,cooldown:160});
  if(/Whirling Dragon Punch/i.test(n)||t==='whirlingDragonPunch')return this.playSample('lightning_cast',{gain:.58,rate:.90,cooldown:240});
  if(/Zephyr Palm/i.test(n))return this.playSample('fast_swing',{gain:.34,rate:1.18,cooldown:80});
  if(/Cloudstep Kick/i.test(n))return this.playSample('finisher',{gain:.52,rate:.88,cooldown:110});
  if(/Chi Burst/i.test(n)||t==='chiBurst')return this.play('windChi');
  if(cls==='wind'||s==='wind')return this.play(/Strike|Palm|Kick|Cyclone|Sweep|Disabling/i.test(n)?'windMonk':'wind');
  if(cls==='soul'){
   if(/Unstable Affliction|Chaos Bolt/i.test(n))return this.play('soulVoid');
   if(/Immolate/i.test(n))return this.play('flameLegacy');
   if(/Soul Scar|Creeping Torment|Grasping Gloom/i.test(n))return this.play('shadowLegacy');
   if(/Soul Barrier/i.test(n))return this.play('magicBuff');
   if(/Dark Pact/i.test(n))return this.play('wardLegacy');
   if(/Undying Resolve/i.test(n)||t==='undyingResolve')return this.play('shadowLegacy');
   if(/Pandemic Bloom|Essence Siphon/i.test(n)||t==='soulDrain')return this.play('soulBloom');
   return this.play('shadowLegacy');
  }
  if(/Fire Shield|Combustion/i.test(n)||t==='flameShield'||t==='combustion')return this.play('fireShield');
  if(cls==='flame'||s==='fire'){
   if(/Cinder Bolt/i.test(n))return this.play('flameMage');
   if(/Ember Lance/i.test(n))return this.play('flameLegacy');
   if(/Living Bomb|Meteor|Dragon Breath/i.test(n))return this.play('fireBurstLegacy');
   return this.play('flameLegacy');
  }
  if(cls==='storm'){
   if(/Arc Spark/i.test(n))return this.playSample('lightning_cast',{gain:.43,rate:1.08,cooldown:80});
   if(/Forked Current/i.test(n))return this.playSample('lightning_cast',{gain:.55,rate:.82,cooldown:120});
   if(/Healing Surge/i.test(n))return this.playSample('magic_buff',{gain:.52,rate:1.02,cooldown:180});
   if(/Gale Reversal/i.test(n))return this.playSample('heavy_whoosh',{gain:.54,rate:1.18,cooldown:160});
   if(/Wind Shear/i.test(n)||t==='interrupt')return this.playSample('heavy_whoosh',{gain:.40,rate:1.35,cooldown:120});
   if(/Skybreaker Pulse/i.test(n)||t==='stun')return this.playSample('lightning_cast',{gain:.66,rate:.72,cooldown:180});
   if(/Grounding Aegis|Static Aegis/i.test(n)||t==='shieldSelf')return this.play('stormShield');
   if(/Stormkeeper/i.test(n)||t==='stormkeeper')return this.play('rune');
   if(/Totem Mastery/i.test(n)||t==='totemMastery')return this.play('magicBuff');
   if(/Static Snare/i.test(n))return this.playSample('dark_debuff',{gain:.36,rate:.82,cooldown:180});
   if(/Static Field/i.test(n)||t==='root')return this.playSample('ice_cast',{gain:.42,rate:.76,cooldown:160});
   if(/Frost Shock/i.test(n)||['frostShock','slow'].includes(t))return this.playSample('ice_impact',{gain:.38,rate:1.06,cooldown:100});
   if(/Flame Shock|Lava Burst/i.test(n))return this.play('flameLegacy');
   return this.play('stormLegacy');
  }
  if(t==='interruptProc'||t==='interrupt'||t==='windInterrupt'||t==='shadowInterrupt') return this.play('interrupt');
  if(t==='stun'||t==='singleStun'||t==='windStun') return this.play(cls==='warrior'?'warriorBlade':'stun');
  if(t==='root'||t==='slow'||t==='frostShock') return this.play('root');
  if(cls==='warrior'||s==='physical')return this.play(/Slash|Swing|Rend|Pummel|Execute|Bladestorm|Warbreaker|Charge/i.test(n)?'warriorBlade':'shadow');
  if(cls==='shadow')return this.play('rogueSteel');
  if(['shield','shieldSelf','defensive','iceBlock','warriorGuard','reflect'].includes(t)) return this.play('shield');
  if(['dash','leap','push','paladinSteed','charge'].includes(t)) return this.play('dash');
 }

}

class Game {
 constructor(){this.canvas=$('#gameCanvas');this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0x0c1113);this.scene.fog=null;this.camera=new THREE.PerspectiveCamera(55,innerWidth/innerHeight,.1,150);this.cameraRig={yaw:-Math.PI/2,facingYaw:-Math.PI/2,pitch:.34,distance:12.4,minDistance:6.8,maxDistance:26,dragging:false,freeLook:false,turning:false,leftMoved:false,startX:0,startY:0,lastX:0,lastY:0};this.camera.position.set(-12,6,0);this.renderer=new THREE.WebGLRenderer({canvas:this.canvas,antialias:true,powerPreference:'high-performance'});this.renderer.setPixelRatio(1);this.renderer.setSize(innerWidth,innerHeight,false);this.clock=new THREE.Clock();this.ray=new THREE.Raycaster();this.mouse=new THREE.Vector2();this.groundPlane=new THREE.Plane(new THREE.Vector3(0,1,0),0);this.groundTargeting=null;this.units=[];this.effects=[];this.disposeQueue=[];this.logs=[];this.keys={};this.target=null;this.player=null;this.phase='menu';this.finishPending=false;this.finishTimer=null;this.paused=false;this.time=0;this.dampening=0;this.difficulty='normal';this.mode='2v2';this.shake=0;this.audio=new AudioManager();this.menuPreviewRenderer=null;this.menuPreviewScene=null;this.menuPreviewCamera=null;this.menuPreviewModel=null;this.menuPreviewGearAppearance=null;this.menuPreviewYaw=.26;this.guideRenderer=null;this.guideScene=null;this.guideCamera=null;this.guideModel=null;this.guideYaw=0;this.guideDragging=false;this.armouryRenderer=null;this.armouryScene=null;this.armouryCamera=null;this.armouryModel=null;this.armouryGearAppearance=null;this.armouryTransmog=null;this.armouryYaw=.35;this.armouryDragging=false;this.collectionView='inventory';this.focusViewAbility={};this.encounterView=null;this.detailsSelection=null;this.achievementQueue=[];this.achievementShowing=false;this.hudEditMode=false;this.hudDrag=null;this.hudEditWasPaused=false;this.htmlCache=new WeakMap();this.textCache=new WeakMap();this.styleCache=new WeakMap();this.effectQueryFrame=0;this.renderScale=1;this.performanceTier=0;this.visualFrame=0;this.fpsFrames=0;this.fpsWindowStart=performance.now();this.currentFps=60;this.lowFpsWindows=0;this.highFpsWindows=0;this.nextHudRichUpdate=0;this.lastRenderRatio=0;this.setupScene();this.bindUI();this.setupHudEditor();this.applyHudScale();this.applyHudLayout();this.applyRenderQuality();this.animate();}
 setupScene(){const amb=new THREE.HemisphereLight(0x99aeca,0x18221b,1.32);this.scene.add(amb);const sun=new THREE.DirectionalLight(0xf5d59a,1.55);sun.position.set(9,25,6);sun.castShadow=false;this.scene.add(sun);const rim=new THREE.PointLight(0x5f3cff,32,58);rim.position.set(-18,11,-10);this.scene.add(rim);const fire=new THREE.PointLight(0xff7a36,18,34);fire.position.set(18,6,8);this.scene.add(fire);this.arena=new Arena(this.scene);}
 warmEffectShaders(){
  if(this.effectShadersWarm||!this.renderer?.compile)return;
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(55,1,.1,20),objects=[];
  camera.position.set(0,0,5);
  scene.add(new THREE.HemisphereLight(0xffffff,0x223344,1),new THREE.DirectionalLight(0xffffff,1));
  const add=(object,x)=>{object.position.set(x,0,0);scene.add(object);objects.push(object);};
  add(new THREE.Mesh(new THREE.SphereGeometry(.35,8,6),new THREE.MeshStandardMaterial({color:0x88ccff,emissive:0x224466,emissiveIntensity:1,transparent:true,opacity:.8})), -1.5);
  add(new THREE.Mesh(new THREE.RingGeometry(.2,.45,16),new THREE.MeshBasicMaterial({color:0xa86cff,transparent:true,opacity:.8,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending})), -.5);
  add(new THREE.Mesh(new THREE.SphereGeometry(.35,8,6),new THREE.MeshBasicMaterial({color:0x66ddff,transparent:true,opacity:.65,wireframe:true})), .5);
  const pointGeometry=new THREE.BufferGeometry();pointGeometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,.1,.1,0,-.1,.1,0],3));
  add(new THREE.Points(pointGeometry,new THREE.PointsMaterial({color:0xffffff,size:.12,transparent:true,opacity:.8,depthWrite:false,blending:THREE.AdditiveBlending})),1.5);
  this.renderer.compile(scene,camera);this.effectShadersWarm=true;this.effectWarmupResources=objects;
 }
 warmMatchRenderer(){if(!this.renderer?.compile||this.phase==='menu'||!this.units.length)return;const started=performance.now();try{this.warmEffectShaders();this.renderer.compile(this.scene,this.camera);this.shaderWarmupMs=performance.now()-started;this.shaderWarmupComplete=true;}catch(error){console.warn('Renderer warm-up skipped:',error);}}
 setHudHtml(element,html){if(!element||this.htmlCache.get(element)===html)return;element.innerHTML=html;this.htmlCache.set(element,html);}
 setHudText(element,value){if(!element)return;const text=String(value);if(this.textCache.get(element)===text)return;element.textContent=text;this.textCache.set(element,text);}
 setHudStyle(element,property,value){if(!element)return;let cache=this.styleCache.get(element);if(!cache){cache={};this.styleCache.set(element,cache);}if(cache[property]===value)return;element.style[property]=value;cache[property]=value;}
 applyHudScale(){const scale=clamp(Number(progression.settings?.hudScale)||1,.7,1.4);progression.settings.hudScale=scale;const hud=$('#hud');if(hud)hud.style.setProperty('--hud-scale',String(scale));const input=$('#hudScale'),label=$('#hudScaleLabel');if(input)input.value=String(Math.round(scale*100));if(label)label.textContent=`${Math.round(scale*100)}%`;this.applyHudLayout();}
 applyRaidFrameStyle(){const style=progression.settings?.raidFrameStyle==='class'?'class':'detailed',hud=$('#hud'),input=$('#raidFrameStyle');hud?.classList.toggle('raid-frames-class',style==='class');if(input)input.value=style;}
 applyHudLayout(){const layout=progression.settings?.hudLayout||{},globalScale=clamp(Number(progression.settings?.hudScale)||1,.7,1.4);document.querySelectorAll('#hud .hud-widget').forEach(widget=>{const point=layout[widget.dataset.hudId]||{},x=Number.isFinite(Number(point.x))?Number(point.x):0,y=Number.isFinite(Number(point.y))?Number(point.y):0,localScale=clamp(Number(point.scale)||1,.5,1.8);widget.style.setProperty('--hud-x',`${x}px`);widget.style.setProperty('--hud-y',`${y}px`);widget.style.setProperty('--hud-widget-scale',String(localScale));widget.style.setProperty('--hud-combined-scale',String(globalScale*localScale));});this.applyRaidFrameStyle();}
 selectHudWidget(widget){if(!widget)return;this.hudSelectedWidget=widget;document.querySelectorAll('#hud .hud-widget').forEach(el=>el.classList.toggle('hud-widget-selected',el===widget));const point=progression.settings?.hudLayout?.[widget.dataset.hudId]||{},scale=clamp(Number(point.scale)||1,.5,1.8),input=$('#hudElementScale'),label=$('#hudElementScaleLabel'),selection=$('#hudEditSelection');if(input)input.value=String(Math.round(scale*100));if(label)label.textContent=`${Math.round(scale*100)}%`;if(selection)selection.textContent=widget.dataset.hudLabel||'Selected HUD element';}
 resetHudLayout(){progression.settings.hudLayout={};saveProgression();this.applyHudLayout();if(this.hudSelectedWidget)this.selectHudWidget(this.hudSelectedWidget);}
 beginHudEdit(){if(this.phase==='menu'){const status=$('#performanceStatus');if(status)status.textContent='Start a match before editing the combat HUD';return;}this.hudEditWasPaused=this.paused;this.paused=true;this.keys={};$('#settings')?.classList.add('hidden');$('#pauseMenu')?.classList.add('hidden');$('#hud')?.classList.add('hud-editing');$('#hudEditBar')?.classList.remove('hidden');this.hudEditMode=true;this.selectHudWidget($('#allyFrames')||document.querySelector('#hud .hud-widget'));}
 finishHudEdit(){this.hudDrag=null;this.hudEditMode=false;this.hudSelectedWidget=null;$('#hud')?.classList.remove('hud-editing');document.querySelectorAll('#hud .hud-widget').forEach(el=>el.classList.remove('hud-widget-selected'));$('#hudEditBar')?.classList.add('hidden');this.paused=!!this.hudEditWasPaused;}
 setupHudEditor(){const hud=$('#hud');if(!hud)return;$('#finishHudEdit').onclick=()=>this.finishHudEdit();$('#resetHudLayout').onclick=()=>this.resetHudLayout();$('#editHud').onclick=()=>this.beginHudEdit();const scaleInput=$('#hudElementScale');if(scaleInput)scaleInput.oninput=event=>{const widget=this.hudSelectedWidget;if(!widget)return;const id=widget.dataset.hudId,scale=clamp(Number(event.target.value)/100,.5,1.8),current=progression.settings.hudLayout?.[id]||{};progression.settings.hudLayout=progression.settings.hudLayout||{};progression.settings.hudLayout[id]={x:Number(current.x)||0,y:Number(current.y)||0,scale};$('#hudElementScaleLabel').textContent=`${Math.round(scale*100)}%`;this.applyHudLayout();saveProgression();};hud.addEventListener('pointerdown',event=>{if(!this.hudEditMode||event.target.closest('#hudEditBar'))return;const widget=event.target.closest('.hud-widget');if(!widget)return;event.preventDefault();event.stopPropagation();this.selectHudWidget(widget);const saved=progression.settings.hudLayout?.[widget.dataset.hudId]||{x:0,y:0,scale:1};this.hudDrag={widget,id:widget.dataset.hudId,startX:event.clientX,startY:event.clientY,x:Number(saved.x)||0,y:Number(saved.y)||0,scale:clamp(Number(saved.scale)||1,.5,1.8)};},{capture:true});window.addEventListener('pointermove',event=>{if(!this.hudDrag)return;const x=clamp(this.hudDrag.x+event.clientX-this.hudDrag.startX,-innerWidth*.8,innerWidth*.8),y=clamp(this.hudDrag.y+event.clientY-this.hudDrag.startY,-innerHeight*.8,innerHeight*.8);this.hudDrag.widget.style.setProperty('--hud-x',`${Math.round(x)}px`);this.hudDrag.widget.style.setProperty('--hud-y',`${Math.round(y)}px`);this.hudDrag.next={x:Math.round(x),y:Math.round(y),scale:this.hudDrag.scale};});window.addEventListener('pointerup',()=>{if(!this.hudDrag)return;progression.settings.hudLayout=progression.settings.hudLayout||{};progression.settings.hudLayout[this.hudDrag.id]=this.hudDrag.next||{x:this.hudDrag.x,y:this.hudDrag.y,scale:this.hudDrag.scale};this.hudDrag=null;saveProgression();});}
 performanceLabel(){return 'Full Quality';}
 targetFrameRate(){return 0;}
 simulationFrameRate(){return 0;}
 sampleRefreshRate(){}
 updatePerformancePresentation(){document.body.classList.remove('performance-combat','performance-menu','performance-critical');const status=$('#performanceStatus');if(status){const work=Number.isFinite(this.frameWorkMs)?`${this.frameWorkMs.toFixed(1)} ms frame work`:'measuring frame work';status.textContent=`Full-quality native rendering · uncapped browser frame loop · ${work}`;}}
 resetPerformance(){const now=performance.now();this.renderScale=1;this.performanceTier=0;this.lowFpsWindows=0;this.highFpsWindows=0;this.nextHudRichUpdate=0;this.nextHudFrameAt=0;this.lastVisualAt=0;this.lastRenderedAt=0;this.simulationAccumulator=0;this.aiAccumulator=0;this.frameWorkMs=0;this.performanceAdaptAt=now+(this.phase==='menu'?2200:5000);this.fpsFrames=0;this.fpsWindowStart=now;this.applyRenderQuality();}
 applyRenderQuality(){if(!this.renderer)return;const ratio=Math.max(.5,Math.min(devicePixelRatio||1,1.25));if(Math.abs(ratio-this.lastRenderRatio)>.015||this.canvas.width!==Math.round(innerWidth*ratio)||this.canvas.height!==Math.round(innerHeight*ratio)){this.renderer.setPixelRatio(ratio);this.renderer.setSize(innerWidth,innerHeight,false);this.lastRenderRatio=ratio;}this.updatePerformancePresentation();}
 recordFps(now,workMs=0){this.frameWorkMs=Number.isFinite(this.frameWorkMs)?this.frameWorkMs*.88+workMs*.12:workMs;this.fpsFrames++;const elapsed=now-this.fpsWindowStart;if(elapsed<900)return;this.currentFps=Math.max(1,Math.round(this.fpsFrames*1000/elapsed));this.fpsFrames=0;this.fpsWindowStart=now;const cost=this.frameWorkMs||0,critical=this.currentFps<22||cost>24,strained=!critical&&((this.currentFps<55&&cost>8.5)||cost>14),counter=$('#fpsCounter');if(counter){counter.textContent=`${this.currentFps} FPS · ${this.performanceLabel()}`;counter.classList.toggle('hidden',!progression.settings?.showFPS);counter.classList.toggle('fps-low',strained);counter.classList.toggle('fps-critical',critical);}this.updatePerformancePresentation();}
 bindUI(){
  $('#queueSelect').onchange=()=>{if($('#queueSelect').value==='training')$('#arenaSelect').value='training';else if($('#arenaSelect').value==='training')$('#arenaSelect').value='random';this.setArenaTheme($('#arenaSelect').value||'random');this.preview();this.refreshMenuProgress();};
  $('#modeSelect').onchange=()=>{this.preview();this.refreshMenuProgress();if(!$('#armoury').classList.contains('hidden'))this.renderArmoury();};
  $('#classSelect').onchange=()=>{this.syncMenuCards();this.preview();this.refreshMenuProgress();};
  $('#difficultySelect').onchange=()=>this.preview();
  const arenaSel=$('#arenaSelect'); if(arenaSel) arenaSel.onchange=e=>{if(e.target.value==='training'&&$('#queueSelect').value!=='training'){$('#queueSelect').value='training';this.message?.('Queue Type changed to Training for the Training Grounds');}this.setArenaTheme(e.target.value);this.preview();this.refreshMenuProgress();};
  $('#startBtn').onclick=()=>{syncTalentUnlockedAbilities();this.start();};
  $('#armouryBtn').onclick=()=>this.openArmoury($('#classSelect').value);
  $('#closeArmoury').onclick=()=>this.closeArmoury();
  $('#buyGearBtn').onclick=()=>this.buyGear();
  $('#shopClass').onchange=()=>this.renderArmoury();
  $('#shopSlot').onchange=()=>this.renderArmoury();
  $('#shopIlvl').onchange=()=>this.renderArmoury();
  $('#shopStatA').onchange=()=>this.renderArmoury();
  $('#shopStatB').onchange=()=>this.renderArmoury();
  $('#loadoutClass').onchange=()=>{const cls=$('#loadoutClass').value;$('#shopClass').value=cls;this.selectArmouryClass(cls);this.renderArmoury();};
  $('#inventoryTab').onclick=()=>{this.collectionView='inventory';this.renderArmoury();};
  $('#catalogueTab').onclick=()=>{this.collectionView='catalogue';this.renderArmoury();};
  document.querySelectorAll('[data-inventory-filter]').forEach(btn=>btn.onclick=()=>{this.inventoryFilter=btn.dataset.inventoryFilter||'all';this.renderArmoury();});
  $('#catalogueClass').onchange=()=>this.renderCatalogue();
  $('#catalogueRarity').onchange=()=>this.renderCatalogue();
  $('#guideBtn').onclick=()=>this.openClassGuide($('#classSelect').value);
   const talentBtn=$('#talentsBtn');if(talentBtn)talentBtn.onclick=e=>{e.preventDefault();this.safeOpenTalents($('#classSelect')?.value||'flame');};
  $('#closeClassGuide').onclick=()=>this.closeClassGuide();
   if($('#closeTalents'))$('#closeTalents').onclick=()=>this.closeTalents();
   if($('#learnTalentBtn'))$('#learnTalentBtn').onclick=()=>this.learnSelectedTalent();
   if($('#resetTalentsBtn'))$('#resetTalentsBtn').onclick=()=>this.resetTalents();
  $('#mountJournalBtn').onclick=()=>this.openMountJournal();
  $('#closeMountJournal').onclick=()=>this.closeMountJournal();
  $('#mountSearch').oninput=()=>this.renderMountJournal();
  $('#mountFilter').onchange=()=>this.renderMountJournal();
  $('#mountAchievementBtn').onclick=()=>{this.closeMountJournal();this.openAchievements();this.achievementFilter='rating';this.renderAchievements();};
  $('#achievementsBtn').onclick=()=>this.openAchievements();$('#tournamentBtn').onclick=()=>this.openTournament();$('#closeTournament').onclick=()=>this.closeTournament();$('#startTournamentBtn').onclick=()=>this.startTournament();$('#playTournamentBtn').onclick=()=>this.playTournamentMatch();
  $('#closeAchievements').onclick=()=>this.closeAchievements();
  $('#menuSettings').onclick=()=>this.openSettings(false);
  $('#closeSettings').onclick=()=>this.closeSettings();
  $('#pauseResume').onclick=()=>this.closePauseMenu();
  $('#pauseSettingsBtn').onclick=()=>{this.closePauseMenu(false);this.openSettings(true);};
  $('#pauseMainMenu').onclick=()=>{this.closePauseMenu(false);this.returnMenu();};
  $('#resetBinds').onclick=()=>{binds={...DEFAULT_BINDS};focusCasts={};abilityLayouts={};this.saveBinds();this.saveFocusCasts();localStorage.removeItem('aetherAbilityLayouts');this.renderBindSettings();this.renderActions();};
  $('#focusClassSelect').onchange=()=>this.renderFocusSettings();
  $('#focusAbilitySelect').onchange=()=>this.renderFocusSettings();
  $('#soundEnabled').onchange=e=>{localStorage.setItem('aetherSound',e.target.checked?'1':'0');this.audio.setEnabled(e.target.checked);};
  $('#hideCombatText').checked=!!progression.settings?.hideCombatText;
  $('#hideCombatText').onchange=e=>{progression.settings.hideCombatText=!!e.target.checked;saveProgression();};
  const hideLiveDetails=$('#hideLiveDetails');if(hideLiveDetails){hideLiveDetails.checked=!!progression.settings?.hideLiveDetails;hideLiveDetails.onchange=e=>{progression.settings.hideLiveDetails=!!e.target.checked;saveProgression();this.updateDetailsVisibility();};}
  $('#stackingNameplates').checked=progression.settings?.stackingNameplates!==false;   $('#stackingNameplates').onchange=e=>{progression.settings.stackingNameplates=!!e.target.checked;saveProgression();this.units?.forEach(u=>u.plate?.classList.remove('auto-stacked'));if(this.phase!=='menu')this.updateUI();};const targetOfTargetToggle=$('#showTargetOfTarget');if(targetOfTargetToggle){targetOfTargetToggle.checked=progression.settings?.showTargetOfTarget!==false;targetOfTargetToggle.onchange=e=>{progression.settings.showTargetOfTarget=!!e.target.checked;saveProgression();if(this.phase!=='menu')this.updateUI();};}
  const hudScale=$('#hudScale'),raidFrameStyle=$('#raidFrameStyle'),instantCamera=$('#instantCamera'),showFPS=$('#showFPS'),performanceMode=$('#performanceMode');if(hudScale){hudScale.value=String(Math.round((progression.settings?.hudScale||1)*100));hudScale.oninput=e=>{progression.settings.hudScale=clamp(Number(e.target.value)/100,.7,1.4);this.applyHudScale();saveProgression();};}if(raidFrameStyle){raidFrameStyle.value=progression.settings?.raidFrameStyle==='class'?'class':'detailed';raidFrameStyle.onchange=e=>{progression.settings.raidFrameStyle=e.target.value==='class'?'class':'detailed';this.applyRaidFrameStyle();saveProgression();};}if(instantCamera){instantCamera.checked=progression.settings?.instantCamera!==false;instantCamera.onchange=e=>{progression.settings.instantCamera=!!e.target.checked;saveProgression();};}if(showFPS){showFPS.checked=!!progression.settings?.showFPS;showFPS.onchange=e=>{progression.settings.showFPS=!!e.target.checked;saveProgression();$('#fpsCounter')?.classList.toggle('hidden',!e.target.checked);};}if(performanceMode){performanceMode.checked=progression.settings?.performanceMode!==false;performanceMode.onchange=e=>{progression.settings.performanceMode=!!e.target.checked;saveProgression();this.resetPerformance();};}
  $('#soundVolume').oninput=e=>{$('#soundVolumeLabel').textContent=e.target.value+'%';this.audio.setVolume(Number(e.target.value)/100);};
  window.onresize=()=>{this.camera.aspect=innerWidth/innerHeight;this.camera.updateProjectionMatrix();this.applyRenderQuality();this.applyHudLayout();};
  document.addEventListener('visibilitychange',()=>{const now=performance.now();this.lastLoopAt=now;this.lastVisualAt=now;this.lastRenderedAt=now;this.simulationAccumulator=0;this.aiAccumulator=0;this.clock?.getDelta();});
  window.addEventListener('keydown',e=>this.keydown(e));window.addEventListener('keyup',e=>this.keys[e.code]=false);this.canvas.addEventListener('contextmenu',e=>e.preventDefault());this.canvas.addEventListener('pointerdown',e=>{if(this.groundTargeting){e.preventDefault();e.stopPropagation();this.updateGroundTarget(e);if(e.button===0)this.confirmGroundTarget();else if(e.button===2)this.cancelGroundTarget('Ground targeting cancelled');return;}const r=this.cameraRig;if(e.button===2){r.dragging=true;r.turning=true;r.freeLook=false;r.leftMoved=false;r.lastX=e.clientX;r.lastY=e.clientY;this.canvas.classList.add('camera-turn');this.canvas.setPointerCapture(e.pointerId);e.preventDefault();}else if(e.button===0&&this.phase!=='menu'){r.dragging=true;r.freeLook=true;r.turning=false;r.leftMoved=false;r.startX=e.clientX;r.startY=e.clientY;r.lastX=e.clientX;r.lastY=e.clientY;this.canvas.classList.add('camera-look');this.canvas.setPointerCapture(e.pointerId);e.preventDefault();}else if(e.button===0){this.pick(e);}});this.canvas.addEventListener('pointermove',e=>{if(this.groundTargeting){this.updateGroundTarget(e);e.preventDefault();return;}const r=this.cameraRig;if(!r.dragging)return;const dx=e.clientX-r.lastX,dy=e.clientY-r.lastY;if(r.freeLook&&Math.hypot(e.clientX-r.startX,e.clientY-r.startY)>4)r.leftMoved=true;r.yaw-=dx*.006;r.pitch=clamp(r.pitch+dy*.004,.08,1.05);if(r.turning)r.facingYaw=r.yaw;r.lastX=e.clientX;r.lastY=e.clientY;e.preventDefault();});const stopTurn=e=>{const r=this.cameraRig;if(r.freeLook&&!r.leftMoved&&e&&e.button===0)this.pick(e);r.dragging=false;r.freeLook=false;r.turning=false;r.leftMoved=false;this.canvas.classList.remove('camera-turn','camera-look');};this.canvas.addEventListener('pointerup',stopTurn);this.canvas.addEventListener('pointercancel',stopTurn);this.canvas.addEventListener('wheel',e=>{if(this.phase==='menu')return;this.cameraRig.distance=clamp(this.cameraRig.distance+Math.sign(e.deltaY)*.8,this.cameraRig.minDistance,this.cameraRig.maxDistance);e.preventDefault();},{passive:false});
  this.buildMenuClassCards();this.setArenaTheme($('#arenaSelect')?.value||'random');this.preview();this.refreshMenuProgress();
 }
 refreshMenuProgress(){
  const el=$('#menuProgress');if(!el)return;
  const cls=$('#classSelect')?.value||'flame',mode=bracketKey($('#modeSelect')?.value||'2v2'),rating=classRating(cls,mode),unlock=unlockedItemLevel(),queue=$('#queueSelect')?.value||'ranked';
  el.innerHTML=`<span>${classIcon(cls,CLASS_INFO[cls].badge)} <strong>${CLASS_INFO[cls].name}</strong> ${mode.toUpperCase()} ${queue==='ranked'?'Rating':'Queue'}: <strong>${queue==='ranked'?rating:(queue==='training'?'Training Grounds':'Skirmish')}</strong></span><span>💠 Valor Shards: <strong>${progression.shards}</strong></span><span>Gear Access: <strong>ilvl ${unlock}</strong></span><span>Title: <strong>${playerTitleLabel()}</strong></span><span>Achievements: <strong>${unlockedAchievementCount()} / ${ACHIEVEMENTS.length}</strong></span>`;
  const rated=$('#rankedOverview');if(rated){const cards=['1v1','2v2','3v3'].map(br=>{const r=classRating(cls,br),tier=ratingTierMeta(r);return `<div class="rating-card"><div class="top"><b>${br} Rating</b><span class="icon" style="color:${tier.css};border-color:${tier.css}55">${tier.icon}</span></div><div class="value">${r}</div><div class="meta"><strong style="color:${tier.css}">${tier.name}</strong> · ${CLASS_INFO[cls].name}</div><div class="sub">Ranked bracket progress</div></div>`;}).join('');rated.innerHTML=cards;}
 }
 getEquippedItems(cls){
  const loadout=progression.equipped[cls]||{};
  return GEAR_SLOTS.map(slot=>progression.inventory.find(item=>item.id===loadout[slot])).filter(Boolean);
 }
 getEquippedStats(cls){
  const totals=blankStats();
  this.getEquippedItems(cls).forEach(item=>{const values=itemStatValues(item);GEAR_STATS.forEach(stat=>totals[stat]+=values[stat]||0);});
  return totals;
 }
 getAllyScaledItems(cls){
  const preferred=GEAR_BUILD_INFO[cls]?.stats||['Power','Vitality'];
  return (this.allyGearProfile||[]).map(item=>({
   classKey:cls,slot:item.slot,ilvl:item.ilvl,statA:preferred[0],statB:preferred[1],
   name:gearName(cls,item.slot,item.ilvl),rarity:rarityForIlvl(item.ilvl),source:'Scaled Ally Loadout'
  }));
 }
 getAllyScaledStats(cls){
  const totals=blankStats();
  this.getAllyScaledItems(cls).forEach(item=>{const values=itemStatValues(item);GEAR_STATS.forEach(stat=>totals[stat]+=values[stat]||0);});
  return totals;
 }
 getEnemyScaledItems(cls){
  const preferred=GEAR_BUILD_INFO[cls]?.stats||['Power','Vitality'];
  return (this.enemyGearProfile||[]).map(item=>({
   classKey:cls,slot:item.slot,ilvl:item.ilvl,statA:preferred[0],statB:preferred[1],
   name:gearName(cls,item.slot,item.ilvl),rarity:rarityForIlvl(item.ilvl),source:'Scaled Rival Loadout'
  }));
 }
 getEnemyScaledStats(cls){
  const totals=blankStats();
  this.getEnemyScaledItems(cls).forEach(item=>{const values=itemStatValues(item);GEAR_STATS.forEach(stat=>totals[stat]+=values[stat]||0);});
  return totals;
 }
 enemyGearSummary(){
  const profile=this.enemyGearProfile||[];
  if(!profile.length)return 'Rival Scaling: your selected class has no equipped gear, so enemy combatants enter ungeared.';
  const average=Math.round(profile.reduce((sum,item)=>sum+item.ilvl,0)/profile.length);
  return `Rival Scaling: enemies mirror your ${profile.length} equipped slot${profile.length===1?'':'s'} at average ilvl ${average}, using recommended stats for their own classes.`;
 }
 formatStatLine(stats){
  return GEAR_STATS.filter(s=>stats[s]>0).map(s=>`+${stats[s]} ${s}`).join(' · ')||'No bonuses equipped';
 }
 fillArmourySelect(id,items,current){
  const el=$(id),desired=current||el.value;el.innerHTML=items.map(o=>`<option value="${o.value}">${o.label}</option>`).join('');
  if(items.some(o=>o.value===desired))el.value=desired;
 }
 openArmoury(cls=null){
  $('#armoury').classList.remove('hidden');
  const chosen=cls||$('#classSelect')?.value||'flame';
  this.fillArmourySelect('#shopClass',GEAR_CLASSES.map(c=>({value:c,label:CLASS_INFO[c].name})),chosen);
  this.fillArmourySelect('#loadoutClass',GEAR_CLASSES.map(c=>({value:c,label:CLASS_INFO[c].name})),chosen);
  this.fillArmourySelect('#shopSlot',GEAR_SLOTS.map(s=>({value:s,label:`${SLOT_ICONS[s]} ${s}`})),'Weapon');
  this.fillArmourySelect('#shopStatA',CUSTOM_GEAR_STATS.map(s=>({value:s,label:s})),'Vitality');
  this.fillArmourySelect('#shopStatB',CUSTOM_GEAR_STATS.map(s=>({value:s,label:s})),'Mana');
  this.fillArmourySelect('#catalogueClass',[{value:'all',label:'All Classes'},...GEAR_CLASSES.map(c=>({value:c,label:`${CLASS_INFO[c].badge} ${CLASS_INFO[c].name}`}))],chosen);
  this.fillArmourySelect('#catalogueRarity',[{value:'all',label:'All Rarities'},{value:'mythical',label:'Purple · Mythical'},{value:'elite',label:'Red · Elite'},{value:'rare',label:'Blue · Rare'},{value:'uncommon',label:'Green · Uncommon'}],'all');
  if(!this.armouryRenderer)this.initArmouryPreview();
  this.selectArmouryClass(chosen);
  this.collectionView='inventory';
  this.inventoryFilter=this.inventoryFilter||'all';
  this.renderArmoury();
 }
 closeArmoury(){this.closeRecraft();$('#armoury').classList.add('hidden');$('#gearTooltip').classList.add('hidden');this.armouryDragging=false;this.refreshMenuProgress();}
 initArmouryPreview(){
  const canvas=$('#armouryCanvas');
  this.armouryRenderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
  this.armouryRenderer.setPixelRatio(Math.min(devicePixelRatio*1.5,3));
  this.armouryScene=new THREE.Scene();
  this.armouryCamera=new THREE.PerspectiveCamera(35,1,.1,60);
  this.armouryCamera.position.set(0,2.15,6.25);this.armouryCamera.lookAt(0,1.18,0);
  this.armouryScene.add(new THREE.HemisphereLight(0xbce9ff,0x100e0a,1.45));
  const key=new THREE.DirectionalLight(0xffd176,2.35);key.position.set(3.4,5.1,3.6);this.armouryScene.add(key);
  const rim=new THREE.PointLight(0x42d9ff,13,12);rim.position.set(-3.2,2.7,-1.5);this.armouryScene.add(rim);
  const base=new THREE.Mesh(new THREE.CylinderGeometry(1.28,1.52,.15,32),new THREE.MeshStandardMaterial({color:0x30271c,metalness:.25,roughness:.62}));base.position.y=-.12;this.armouryScene.add(base);
  const ring=new THREE.Mesh(new THREE.RingGeometry(.83,1.06,32),new THREE.MeshBasicMaterial({color:0xe4ad42,transparent:true,opacity:.7,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=-.035;this.armouryScene.add(ring);
  canvas.addEventListener('pointerdown',e=>{this.armouryDragging=true;this.armouryLastX=e.clientX;canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!this.armouryDragging)return;this.armouryYaw+=(e.clientX-this.armouryLastX)*.012;this.armouryLastX=e.clientX;});
  const stop=()=>this.armouryDragging=false;canvas.addEventListener('pointerup',stop);canvas.addEventListener('pointercancel',stop);
 }
 applyBaseGearVisibility(model,items=[]){
  if(!model)return;
  const equippedSlots=new Set((items||[]).map(item=>item.slot));
  model.traverse(part=>{
   const slots=part.userData?.baseGearSlots;
   if(slots&&slots.length)part.visible=!slots.some(slot=>equippedSlots.has(slot));
  });
 }
 gearAppearanceItems(cls){
  const equipped=this.getEquippedItems(cls);
  if(this.armouryTransmog&&this.armouryTransmog.classKey===cls){
   const build=GEAR_BUILD_INFO[cls].stats;
   const previewItem=createGearItem(cls,this.armouryTransmog.slot,this.armouryTransmog.ilvl,build[0],build[1],'Transmog Preview');
   const filtered=equipped.filter(item=>item.slot!==this.armouryTransmog.slot);
   filtered.push(previewItem);
   return filtered;
  }
  return equipped;
 }
 attachGearAppearance(model,cls,items=[],preview=false){
  if(typeof AetherKit!=='undefined'&&AetherKit.ready)return null; /* AetherKit: outfit models are the look; no primitive gear overlay */
  if(!model||!items.length)return null;
  const group=new THREE.Group(),bySlot=new Map(items.map(i=>[i.slot,i])),animations=[],glowTracks=[];
  const rankFor=item=>({uncommon:1,rare:2,elite:3,mythical:4}[rarityForIlvl(item.ilvl||910)]||1);
  const colorFor=item=>parseInt((RARITY_INFO[rarityForIlvl(item.ilvl||910)]?.colour||'#ffffff').replace('#','0x'));
  const makeStyle=item=>{
   const rank=rankFor(item),color=colorFor(item),classCol=CLASS_INFO[cls].colour;
   return {
    rank,color,
    plate:new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:rank>=4?1.72:(rank>=3?1.18:(rank>=2?.42:.18)),metalness:.68,roughness:rank>=3?.14:.38}),
    trim:new THREE.MeshStandardMaterial({color:rank>=3?color:classCol,emissive:rank>=2?color:classCol,emissiveIntensity:rank>=4?2.25:(rank>=3?1.5:(rank>=2?.55:.25)),metalness:.76,roughness:.18}),
    cloth:new THREE.MeshStandardMaterial({color:rank>=3?color:classCol,emissive:color,emissiveIntensity:rank>=4?.84:(rank>=3?.38:(rank>=2?.16:.08)),metalness:.22,roughness:.46,transparent:true,opacity:.96}),
    glow:new THREE.MeshBasicMaterial({color,transparent:true,opacity:rank>=4?.998:(rank>=3?.94:(rank>=2?.7:.45)),side:THREE.DoubleSide}),
    soft:new THREE.MeshStandardMaterial({color:0xf1efe8,emissive:color,emissiveIntensity:rank>=3?.18:.06,roughness:.8}),
    dark:new THREE.MeshStandardMaterial({color:0x1a1824,emissive:color,emissiveIntensity:rank>=4?.22:.05,roughness:.54})
   };
  };
  const add=(mesh,pulseMat=null,pulseBase=.35,pulseAmp=.15,pulseSpeed=2.2)=>{group.add(mesh);if(pulseMat)glowTracks.push({mat:pulseMat,base:pulseBase,amp:pulseAmp,speed:pulseSpeed});return mesh;};
  const animateY=(obj,amp=.05,speed=2.4)=>animations.push({obj,baseY:obj.position.y,amp,speed,type:'y'});
  const animateRot=(obj,speed=1.2)=>animations.push({obj,speed,type:'rot'});
  const addFlux=(pos,style,countBase=6,spread=.12)=>{
   if(style.rank<3)return;
   const count=style.rank===4?countBase+28:(style.rank===3?countBase+14:(style.rank===2?countBase+5:countBase));
   const arr=new Float32Array(count*3);
   for(let i=0;i<count;i++){
    const a=(i/count)*Math.PI*2,r=spread*(1+(i%3)*.55);
    arr[i*3]=pos.x+Math.cos(a)*r;arr[i*3+1]=pos.y+((i%5)-2)*.06;arr[i*3+2]=pos.z+Math.sin(a)*r;
   }
   const geom=new THREE.BufferGeometry();geom.setAttribute('position',new THREE.BufferAttribute(arr,3));
   const pts=new THREE.Points(geom,new THREE.PointsMaterial({color:style.color,size:style.rank===4?.155:(style.rank===3?.11:(style.rank===2?.075:.055)),transparent:true,opacity:style.rank===4?.995:(style.rank===3?.9:(style.rank===2?.8:.72))}));
   add(pts);animateRot(pts,style.rank===4?2.8:1.7);animateY(pts,.03,2.5);
  };
  const addCloak=(style,len=.9,width=.65,back=.24)=>{
   const cape=new THREE.Mesh(new THREE.PlaneGeometry(width,len),style.cloth);cape.position.set(0,1.0,back);cape.rotation.y=Math.PI;add(cape,style.cloth,.18,.08,1.2);return cape;
  };
  const addOrb=(x,y,z,size,style)=>{const orb=new THREE.Mesh(new THREE.SphereGeometry(size,12,10),style.trim);orb.position.set(x,y,z);add(orb,style.trim,.4,.18,2.4);addFlux(orb.position,style,7,.08);return orb;};
  const addBlade=(x,y,z,len,style,flip=1)=>{const blade=new THREE.Mesh(new THREE.ConeGeometry(.05,len,5),style.trim);blade.position.set(x,y,z);blade.rotation.z=.35*flip;add(blade,style.trim,.42,.16,2);return blade;};
  const addShoulderPad=(x,y,style,clsTag='')=>{
   const pad=new THREE.Mesh(new THREE.SphereGeometry(.18+.03*style.rank,10,8),style.plate);pad.scale.set(1.42,.75,1.08);pad.position.set(x,y,0);add(pad,style.plate,.26,.13,1.7);
   if(clsTag==='flame'){const flame=new THREE.Mesh(new THREE.ConeGeometry(.08,.30+.04*style.rank,6),style.trim);flame.position.set(x*1.17,y+.18,0);flame.rotation.z=-Math.sign(x)*.55;add(flame,style.trim,.65,.18,3);}
   if(clsTag==='shadow'){const fin=new THREE.Mesh(new THREE.BoxGeometry(.06,.34,.18),style.trim);fin.position.set(x*1.22,y+.05,0);fin.rotation.z=-Math.sign(x)*.6;add(fin,style.trim,.55,.12,2.5);}
   if(clsTag==='storm'){const coil=new THREE.Mesh(new THREE.TorusGeometry(.12,.022,6,18),style.glow);coil.rotation.y=Math.PI/2;coil.position.set(x*1.02,y+.02,0);add(coil);animateRot(coil,2.6);}
   if(clsTag==='wind'){const knot=new THREE.Mesh(new THREE.TorusGeometry(.09,.028,6,16),style.glow);knot.position.set(x*1.02,y+.06,.02);add(knot);animateRot(knot,1.8);}
   if(clsTag==='soul'){const skull=new THREE.Mesh(new THREE.OctahedronGeometry(.09+.015*style.rank),style.trim);skull.position.set(x*1.13,y+.06,0);add(skull,style.trim,.52,.16,2.3);}
   if(clsTag==='sage'){const petal=new THREE.Mesh(new THREE.ConeGeometry(.09,.24,7),style.trim);petal.position.set(x*1.08,y+.12,0);petal.rotation.z=Math.sign(x)*.8;add(petal,style.trim,.48,.14,1.9);}
   if(clsTag==='pala'){const wing=new THREE.Mesh(new THREE.BoxGeometry(.08,.34,.22),style.trim);wing.position.set(x*1.2,y+.05,0);wing.rotation.z=-Math.sign(x)*.38;add(wing,style.trim,.52,.14,2.1);}
   if(style.rank>=4)addFlux({x:x*1.08,y:y+.06,z:0},style,6,.09);
  };
  const addBracer=(x,y,style,kind='plain')=>{
   const side=Math.sign(x)||1,rank=style.rank||1,k=1+(rank-1)*.10;
   const gauntlet=new THREE.Mesh(new THREE.BoxGeometry(.18*k,.23*k,.22*k),style.plate);gauntlet.position.set(x,y-.02,-.02);gauntlet.rotation.z=-side*.10;add(gauntlet,style.plate,rank>=3?.52:.24,rank>=3?.14:.08,2.1);
   const cuff=new THREE.Mesh(new THREE.CylinderGeometry(.11*k,.125*k,.22*k,8),style.trim);cuff.position.set(x-side*.045,y+.17,0);cuff.rotation.z=Math.PI/2;add(cuff,style.trim,rank>=3?.62:.30,rank>=3?.16:.08,2.3);
   if(kind==='flame'){const ember=new THREE.Mesh(new THREE.ConeGeometry(.065*k,.27*k,6),style.trim);ember.position.set(x,y+.29,0);add(ember,style.trim,.85,.18,3);}
   if(kind==='shadow'){[-1,0,1].forEach(i=>{const claw=new THREE.Mesh(new THREE.ConeGeometry(.025*k,.18*k,5),style.trim);claw.position.set(x+side*(.09+i*.018),y-.16,-.12+i*.05);claw.rotation.z=-side*.72;add(claw,style.trim,.58,.13,2.5);});}
   if(kind==='storm'){const arc=new THREE.Mesh(new THREE.TorusGeometry(.135*k,.023*k,6,18),style.glow);arc.position.set(x,y+.02,-.12);arc.rotation.y=Math.PI/2;add(arc);animateRot(arc,2.9);}
   if(kind==='wind'){const wrapA=new THREE.Mesh(new THREE.TorusGeometry(.12*k,.024*k,6,18),style.trim);wrapA.position.set(x,y+.04,-.12);wrapA.rotation.y=Math.PI/2;add(wrapA);const ribbon=new THREE.Mesh(new THREE.PlaneGeometry(.08*k,.25*k),style.cloth);ribbon.position.set(x-side*.10,y-.13,.06);add(ribbon,style.cloth,.24,.07,1.8);}
   if(kind==='soul'){const rune=new THREE.Mesh(new THREE.OctahedronGeometry(.075*k),style.trim);rune.position.set(x,y+.04,-.14);add(rune,style.trim,.78,.18,2.7);addFlux({x,y:y+.04,z:-.14},style,8,.07);}
   if(kind==='sage'){const leaf=new THREE.Mesh(new THREE.ConeGeometry(.072*k,.25*k,6),style.trim);leaf.position.set(x,y+.18,-.04);leaf.rotation.z=side*.55;add(leaf,style.trim,.65,.15,2.1);}
   if(kind==='pala'){const vambrace=new THREE.Mesh(new THREE.BoxGeometry(.13*k,.27*k,.07*k),style.trim);vambrace.position.set(x,y+.06,-.15);add(vambrace,style.trim,.7,.15,2.2);const cross=new THREE.Mesh(new THREE.BoxGeometry(.04*k,.16*k,.03*k),style.glow);cross.position.set(x,y+.06,-.20);add(cross);}
  };
  const addBeltPanel=(style,shape='plate',kind='plain')=>{
   const rank=style.rank||1,k=1+(rank-1)*.1;
   const belt=new THREE.Mesh(new THREE.CylinderGeometry(.44*k,.43*k,.15*k,12,1,true),style.plate);belt.position.set(0,.86,0);add(belt,style.plate,rank>=3?.5:.22,rank>=3?.13:.07,2);
   const rim=new THREE.Mesh(new THREE.TorusGeometry(.42*k,.028*k,8,24),style.trim);rim.rotation.x=Math.PI/2;rim.position.set(0,.84,-.01);add(rim,style.trim,.46,.13,2.2);
   const buckle=shape==='gem'?new THREE.Mesh(new THREE.OctahedronGeometry(.14*k),style.trim):new THREE.Mesh(new THREE.BoxGeometry(.20*k,.17*k,.08*k),style.trim);
   buckle.position.set(0,.84,-.43);add(buckle,style.trim,rank>=3?.82:.46,rank>=3?.19:.12,2.8);
   const panel=shape==='cloth'?new THREE.Mesh(new THREE.PlaneGeometry(.30*k,.48*k),style.cloth):new THREE.Mesh(new THREE.BoxGeometry(.25*k,.33*k,.065*k),style.plate);
   panel.position.set(0,.58,-.34);add(panel,shape==='cloth'?style.cloth:style.plate,rank>=3?.42:.2,rank>=3?.12:.06,1.7);
   if(kind==='flame'){const ember=new THREE.Mesh(new THREE.ConeGeometry(.055*k,.22*k,6),style.trim);ember.position.set(0,.85,-.50);add(ember,style.trim,.86,.19,3);}
   if(kind==='shadow'){[-1,1].forEach(v=>{const knife=new THREE.Mesh(new THREE.BoxGeometry(.045*k,.27*k,.04),style.trim);knife.position.set(v*.24,.63,-.39);knife.rotation.z=v*.35;add(knife);});}
   if(kind==='storm'){const coil=new THREE.Mesh(new THREE.TorusGeometry(.17*k,.02*k,6,18),style.glow);coil.position.set(0,.84,-.49);add(coil);animateRot(coil,2.8);}
   if(kind==='wind'){[-1,1].forEach(v=>{const sash=new THREE.Mesh(new THREE.PlaneGeometry(.085*k,.42*k),style.cloth);sash.position.set(v*.15,.56,-.36);sash.rotation.z=v*.12;add(sash,style.cloth,.28,.08,1.8);});}
   if(kind==='soul'){const eye=new THREE.Mesh(new THREE.OctahedronGeometry(.09*k),style.trim);eye.position.set(0,.84,-.51);add(eye,style.trim,.9,.2,2.7);}
   if(kind==='sage'){const leaf=new THREE.Mesh(new THREE.ConeGeometry(.08*k,.23*k,6),style.trim);leaf.position.set(0,.72,-.47);add(leaf,style.trim,.62,.14,2);}
   if(kind==='pala'){const crossV=new THREE.Mesh(new THREE.BoxGeometry(.042*k,.18*k,.035),style.glow);crossV.position.set(0,.84,-.52);add(crossV);const crossH=new THREE.Mesh(new THREE.BoxGeometry(.14*k,.042*k,.035),style.glow);crossH.position.set(0,.84,-.52);add(crossH);}
   return panel;
  };
  const addBoot=(x,style,kind='plain')=>{
   const rank=style.rank||1,k=1+(rank-1)*.10,side=Math.sign(x)||1;
   const boot=new THREE.Mesh(new THREE.BoxGeometry(.25*k,.22*k,.40*k),style.plate);boot.position.set(x,-.055,-.08);add(boot,style.plate,rank>=3?.5:.22,rank>=3?.14:.07,1.9);
   const greave=new THREE.Mesh(new THREE.BoxGeometry(.19*k,.27*k,.13*k),style.trim);greave.position.set(x,.16,-.1);add(greave,style.trim,rank>=3?.64:.28,rank>=3?.14:.08,2.2);
   const toe=new THREE.Mesh(new THREE.BoxGeometry(.22*k,.08*k,.16*k),style.trim);toe.position.set(x,-.13,-.29);add(toe,style.trim,.44,.11,2);
   if(kind==='flame'){const spur=new THREE.Mesh(new THREE.ConeGeometry(.06*k,.25*k,6),style.trim);spur.position.set(x,.16,-.2);spur.rotation.x=-.7;add(spur,style.trim,.82,.18,2.8);}
   if(kind==='shadow'){const hook=new THREE.Mesh(new THREE.ConeGeometry(.045*k,.24*k,5),style.trim);hook.position.set(x+side*.10,-.02,-.27);hook.rotation.x=-.65;add(hook,style.trim,.68,.14,2.4);}
   if(kind==='storm'){const ring=new THREE.Mesh(new THREE.TorusGeometry(.13*k,.022*k,6,18),style.glow);ring.position.set(x,.12,-.18);ring.rotation.y=Math.PI/2;add(ring);animateRot(ring,2.9);}
   if(kind==='wind'){const swirl=new THREE.Mesh(new THREE.TorusGeometry(.12*k,.02*k,6,18),style.glow);swirl.position.set(x,-.14,-.1);swirl.rotation.x=Math.PI/2;add(swirl);animateRot(swirl,2.4);}
   if(kind==='soul'){const mist=new THREE.Mesh(new THREE.CircleGeometry(.16*k,16),style.glow);mist.position.set(x,-.18,0);mist.rotation.x=-Math.PI/2;add(mist);animateRot(mist,2);}
   if(kind==='sage'){const vine=new THREE.Mesh(new THREE.TorusGeometry(.12*k,.022*k,6,16),style.trim);vine.position.set(x,.12,-.18);vine.rotation.y=Math.PI/2;add(vine,style.trim,.5,.1,2);}
   if(kind==='pala'){const sab=new THREE.Mesh(new THREE.BoxGeometry(.10*k,.30*k,.14*k),style.trim);sab.position.set(x,.17,-.17);add(sab,style.trim,.64,.14,2.2);}
  };
  const addClassIdentitySet=(summary)=>{
   if(summary.maxRank<1||!summary.style)return;
   const tier=summary.maxRank,scale=tier===4?1.34:(tier===3?1.17:(tier===2?1.02:.92)),mythic=tier>=4,elite=tier>=3;
   const has=slot=>bySlot.has(slot),sty=slot=>styles[slot]||summary.style;
   const crest=(slot,x,y,z,r)=>{if(!has(slot))return;const s=sty(slot),m=new THREE.Mesh(new THREE.TorusGeometry(r*scale,.024*scale,8,24),s.glow);m.position.set(x,y,z);m.rotation.x=Math.PI/2;add(m);animateRot(m,mythic?3.3:(elite?2.4:1.55));};
   const jewel=(slot,x,y,z,size=.09)=>{if(!has(slot))return;const s=sty(slot),m=new THREE.Mesh(new THREE.OctahedronGeometry(size*scale),s.trim);m.position.set(x,y,z);add(m,s.trim,mythic?1.32:(elite?1.02:.62),mythic?.22:.11,mythic?3.4:2.1);if(elite)addFlux({x,y,z},s,mythic?12:7,mythic?.13:.08);};
   const cloth=(slot,x,y,z,w,h,rot=0)=>{if(!has(slot))return;const s=sty(slot),m=new THREE.Mesh(new THREE.PlaneGeometry(w*scale,h*scale),s.cloth);m.position.set(x,y,z);m.rotation.y=Math.PI;m.rotation.z=rot;add(m,s.cloth,mythic?.32:.15,mythic?.14:.06,1.6);animateY(m,mythic?.08:.03,1.7);};
   const spike=(slot,x,y,z,h,rot=0)=>{if(!has(slot))return;const s=sty(slot),m=new THREE.Mesh(new THREE.ConeGeometry(.065*scale,h*scale,6),s.trim);m.position.set(x,y,z);m.rotation.z=rot;add(m,s.trim,mythic?1.24:(elite?.94:.58),mythic?.2:.1,2.7);};

   if(cls==='flame'){
    crest('Head',0,2.35,0,.23);spike('Head',-.22,2.47,0,.36,.38);spike('Head',.22,2.47,0,.36,-.38);
    spike('Shoulders',-.64,1.76,0,.4,.62);spike('Shoulders',.64,1.76,0,.4,-.62);
    jewel('Chest',0,1.25,-.43,.12);if(has('Chest')){const s=sty('Chest'),sig=new THREE.Mesh(new THREE.ConeGeometry(.14*scale,.38*scale,7),s.trim);sig.position.set(0,1.2,-.42);add(sig,s.trim,mythic?1.4:.7,mythic?.24:.12,3);}
    cloth('Back',-.17,.96,.27,.17,.88,-.08);cloth('Back',.17,.96,.27,.17,.88,.08);
    if(has('Weapon')){const s=sty('Weapon');const tip=new THREE.Mesh(new THREE.OctahedronGeometry(.16*scale),s.trim);tip.position.set(.84,1.54,0);add(tip,s.trim,mythic?1.55:(elite?1.2:.75),mythic?.26:.13,3.2);addFlux({x:.84,y:1.54,z:0},s,mythic?22:(elite?12:6),mythic?.16:.1);}
   }
   if(cls==='shadow'){
    if(has('Head')){const s=sty('Head'),hood=new THREE.Mesh(new THREE.CylinderGeometry(.31*scale,.39*scale,.4*scale,8,1,true),s.cloth);hood.position.set(0,2.12,.03);add(hood,s.cloth,mythic?.28:.13,mythic?.12:.05,1.4);}
    if(has('Shoulders'))[-1,1].forEach(v=>{const s=sty('Shoulders'),fin=new THREE.Mesh(new THREE.BoxGeometry(.07*scale,.5*scale,.2*scale),s.trim);fin.position.set(v*.65,1.58,.04);fin.rotation.z=-v*.54;add(fin,s.trim,mythic?1.22:(elite?.92:.55),mythic?.2:.1,2.6);});
    if(has('Chest')){const s=sty('Chest'),eye=new THREE.Mesh(new THREE.OctahedronGeometry(.13*scale),s.trim);eye.position.set(0,1.3,-.42);add(eye,s.trim,mythic?1.35:(elite?1:.62),mythic?.22:.12,2.8);}
    cloth('Back',-.22,1.0,.27,.15,1.0,-.1);cloth('Back',.22,1.0,.27,.15,1.0,.1);
    if(has('Weapon'))[-1,1].forEach(v=>{const s=sty('Weapon'),blade=new THREE.Mesh(new THREE.BoxGeometry(.06*scale,.72*scale,.14*scale),s.trim);blade.position.set(v*.73,1.0,.08);blade.rotation.z=-v*.42;add(blade,s.trim,mythic?1.36:(elite?1.05:.68),mythic?.22:.12,2.9);});
   }
   if(cls==='storm'){
    crest('Head',0,2.38,0,.25);jewel('Head',0,2.62,0,.12);
    if(has('Shoulders'))[-1,1].forEach(v=>{const s=sty('Shoulders'),coil=new THREE.Mesh(new THREE.TorusGeometry(.18*scale,.028*scale,8,22),s.glow);coil.position.set(v*.54,1.58,0);coil.rotation.y=Math.PI/2;add(coil);animateRot(coil,mythic?4.2:2.6);});
    if(has('Chest')){const s=sty('Chest'),core=new THREE.Mesh(new THREE.TorusKnotGeometry(.1*scale,.024*scale,42,7),s.glow);core.position.set(0,1.24,-.42);add(core);animateRot(core,mythic?3.8:2.3);}
    if(has('Back')){const s=sty('Back');[-1,1].forEach(v=>{const arc=new THREE.Mesh(new THREE.TorusGeometry(.27*scale,.022*scale,8,22,Math.PI),s.glow);arc.position.set(v*.29,1.14,.25);arc.rotation.y=Math.PI;arc.rotation.z=v*1.15;add(arc);animateRot(arc,mythic?3.1:2);});}
    if(has('Weapon')){const s=sty('Weapon'),orb=new THREE.Mesh(new THREE.OctahedronGeometry(.16*scale),s.trim);orb.position.set(.84,1.48,0);add(orb,s.trim,mythic?1.55:(elite?1.18:.72),mythic?.26:.13,3.5);addFlux({x:.84,y:1.48,z:0},s,mythic?24:(elite?14:7),mythic?.18:.1);}
   }
   if(cls==='wind'){
    crest('Head',0,2.25,0,.18);cloth('Head',-.12,2.13,.18,.07,.42,-.14);cloth('Head',.12,2.13,.18,.07,.42,.14);
    if(has('Shoulders'))[-1,1].forEach(v=>{const s=sty('Shoulders'),knot=new THREE.Mesh(new THREE.TorusKnotGeometry(.095*scale,.02*scale,34,6),s.glow);knot.position.set(v*.53,1.55,.03);add(knot);animateRot(knot,mythic?3:1.8);});
    jewel('Chest',0,1.24,-.41,.09);cloth('Back',-.32,1.04,.27,.14,1.1,-.18);cloth('Back',.32,1.04,.27,.14,1.1,.18);
    if(has('Weapon'))[-1,1].forEach(v=>{const s=sty('Weapon'),ring=new THREE.Mesh(new THREE.TorusGeometry(.15*scale,.026*scale,8,20),s.glow);ring.position.set(v*.63,1.02,.06);ring.rotation.y=Math.PI/2;add(ring);animateRot(ring,mythic?3.2:2.1);});
    if(has('Feet'))[-1,1].forEach(v=>{const s=sty('Feet'),rune=new THREE.Mesh(new THREE.CircleGeometry(.13*scale,16),s.glow);rune.position.set(v*.17,-.13,0);rune.rotation.x=-Math.PI/2;add(rune);animateRot(rune,mythic?3:1.6);});
   }
   if(cls==='soul'){
    if(has('Head')){const s=sty('Head'),halo=new THREE.Mesh(new THREE.TorusKnotGeometry(.16*scale,.028*scale,50,8),s.glow);halo.position.set(0,2.3,0);add(halo);animateRot(halo,mythic?3:1.8);spike('Head',-.22,2.5,0,.38,-.35);spike('Head',.22,2.5,0,.38,.35);}
    if(has('Shoulders'))[-1,1].forEach(v=>jewel('Shoulders',v*.58,1.58,.02,.11));
    jewel('Chest',0,1.27,-.42,.14);
    cloth('Back',0,.94,.28,.24,1.08,0);
    if(has('Weapon')){const s=sty('Weapon'),lantern=new THREE.Mesh(new THREE.OctahedronGeometry(.18*scale),s.trim);lantern.position.set(.83,1.43,0);add(lantern,s.trim,mythic?1.5:(elite?1.15:.7),mythic?.24:.13,3.2);addFlux({x:.83,y:1.43,z:0},s,mythic?26:(elite?15:7),mythic?.18:.11);}
    if(has('Trinket')){const s=sty('Trinket'),eye=new THREE.Mesh(new THREE.SphereGeometry(.11*scale,12,10),s.trim);eye.position.set(-.66,1.45,.02);add(eye,s.trim,mythic?1.4:.8,mythic?.2:.12,2.9);}
   }
   if(cls==='sage'){
    crest('Head',0,2.34,0,.2);spike('Head',-.17,2.5,0,.27,-.35);spike('Head',.17,2.5,0,.27,.35);
    if(has('Shoulders'))[-1,1].forEach(v=>{const s=sty('Shoulders'),leaf=new THREE.Mesh(new THREE.ConeGeometry(.1*scale,.34*scale,7),s.trim);leaf.position.set(v*.55,1.68,.02);leaf.rotation.z=v*.62;add(leaf,s.trim,mythic?1.2:(elite?.9:.56),mythic?.2:.1,2.3);});
    if(has('Chest')){const s=sty('Chest'),bloom=new THREE.Mesh(new THREE.TorusKnotGeometry(.11*scale,.024*scale,40,7),s.glow);bloom.position.set(0,1.25,-.41);add(bloom);animateRot(bloom,mythic?2.8:1.8);}
    cloth('Back',-.2,1.02,.27,.18,.9,-.12);cloth('Back',.2,1.02,.27,.18,.9,.12);
    if(has('Weapon')){const s=sty('Weapon'),bloom=new THREE.Mesh(new THREE.TorusKnotGeometry(.13*scale,.027*scale,44,7),s.trim);bloom.position.set(.84,1.46,0);add(bloom,s.trim,mythic?1.36:(elite?1.05:.66),mythic?.2:.1,2.6);}
   }
   if(cls==='pala'){
    crest('Head',0,2.48,0,.28);
    if(has('Shoulders'))[-1,1].forEach(v=>{const s=sty('Shoulders'),wing=new THREE.Mesh(new THREE.PlaneGeometry(.22*scale,.58*scale),s.glow);wing.position.set(v*.64,1.65,.04);wing.rotation.z=-v*.5;add(wing);animateY(wing,mythic?.07:.035,1.6);});
    if(has('Chest')){const s=sty('Chest'),plate=new THREE.Mesh(new THREE.BoxGeometry(.32*scale,.38*scale,.1*scale),s.plate);plate.position.set(0,1.22,-.4);add(plate,s.plate,mythic?1.2:(elite?.95:.58),mythic?.2:.1,2.3);const cross=new THREE.Mesh(new THREE.BoxGeometry(.06*scale,.28*scale,.04),s.trim);cross.position.set(0,1.24,-.46);add(cross,s.trim,mythic?1.35:.8,mythic?.22:.1,2.5);}
    if(has('Back'))[-1,1].forEach(v=>cloth('Back',v*.42,1.2,.27,.34,1.12,-v*.33));
    if(has('Weapon')){const s=sty('Weapon'),head=new THREE.Mesh(new THREE.BoxGeometry(.32*scale,.22*scale,.18*scale),s.plate);head.position.set(.86,1.4,0);add(head,s.plate,mythic?1.4:(elite?1.08:.66),mythic?.22:.12,2.8);crest('Weapon',.86,1.4,0,.13);}
   }
  };
const addAscensionAura=(summary)=>{
   if(summary.maxRank<3)return;
   const baseColor=summary.maxRank>=4?0xc47bff:0xef5459;
   const strong=summary.maxRank>=4;
   const auraMat=new THREE.MeshBasicMaterial({color:baseColor,transparent:true,opacity:strong?.76:.52,side:THREE.DoubleSide});
   const ring1=new THREE.Mesh(new THREE.TorusGeometry(strong?.92:.78,strong?.03:.022,10,40),auraMat);ring1.rotation.x=Math.PI/2;ring1.position.y=.07;add(ring1);animateRot(ring1,strong?2.2:1.5);
   const ring2=new THREE.Mesh(new THREE.TorusGeometry(strong?1.18:.98,strong?.018:.014,10,40),auraMat);ring2.rotation.x=Math.PI/2;ring2.position.y=.09;add(ring2);animateRot(ring2,strong?-1.8:-1.2);
   const sigil=new THREE.Mesh(new THREE.CircleGeometry(strong?1.06:.88,28),auraMat);sigil.rotation.x=-Math.PI/2;sigil.position.y=.03;add(sigil);
   const backGlow=new THREE.Mesh(new THREE.PlaneGeometry(strong?1.05:.82,strong?1.65:1.22),auraMat);backGlow.position.set(0,1.14,.33);backGlow.rotation.y=Math.PI;backGlow.material.opacity=strong?.34:.22;add(backGlow);animateY(backGlow,strong?.06:.035,strong?1.9:1.4);
   if(cls==='flame'){
    [-1,0,1].forEach((v,i)=>{const plume=new THREE.Mesh(new THREE.ConeGeometry(strong?.11:.085,strong?.84:.56,7),summary.style.trim);plume.position.set(v*.24,1.74+i*.08,.22);plume.rotation.x=.35;plume.rotation.z=-v*.22;add(plume,summary.style.trim,strong?1.25:.86,.24,3.1);});
   }
   if(cls==='shadow'){
    [-1,-.35,.35,1].forEach(v=>{const blade=new THREE.Mesh(new THREE.BoxGeometry(.07,strong?.72:.48,.18),summary.style.trim);blade.position.set(v*.42,1.25,.26);blade.rotation.z=-v*.34;add(blade,summary.style.trim,strong?1.15:.82,.22,2.5);});
   }
   if(cls==='storm'){
    [-1,1].forEach(v=>{const coil=new THREE.Mesh(new THREE.TorusGeometry(strong?.22:.16,.026,8,22),summary.style.glow);coil.position.set(v*.34,1.72,.08);coil.rotation.y=Math.PI/2;add(coil);animateRot(coil,strong?4:3);});
    const spire=new THREE.Mesh(new THREE.OctahedronGeometry(strong?.16:.11),summary.style.trim);spire.position.set(0,2.18,0);add(spire,summary.style.trim,strong?1.4:.96,.25,3.8);
   }
   if(cls==='wind'){
    [-1,1].forEach(v=>{const ribbon=new THREE.Mesh(new THREE.PlaneGeometry(strong?.22:.16,strong?1.18:.82),summary.style.glow);ribbon.position.set(v*.4,1.1,.22);ribbon.rotation.y=Math.PI;ribbon.rotation.z=-v*.26;add(ribbon);animateY(ribbon,strong?.08:.05,1.8);});
   }
   if(cls==='soul'){
    const eye=new THREE.Mesh(new THREE.OctahedronGeometry(strong?.18:.13),summary.style.trim);eye.position.set(0,1.48,.22);add(eye,summary.style.trim,strong?1.35:.92,.22,3.3);
    [-1,1].forEach(v=>{const tendril=new THREE.Mesh(new THREE.TorusKnotGeometry(strong?.09:.07,.018,36,6),summary.style.glow);tendril.position.set(v*.28,.98,.22);add(tendril);animateRot(tendril,strong?2.8:2.1);});
   }
   if(cls==='sage'){
    [-1,0,1].forEach(v=>{const petal=new THREE.Mesh(new THREE.ConeGeometry(.08,strong?.46:.32,6),summary.style.trim);petal.position.set(v*.18,1.98,.16);petal.rotation.z=v*.18;add(petal,summary.style.trim,strong?1.16:.86,.2,2.4);});
    const bloom=new THREE.Mesh(new THREE.TorusKnotGeometry(strong?.16:.12,.026,40,6),summary.style.glow);bloom.position.set(0,1.34,.18);add(bloom);animateRot(bloom,strong?2.5:1.8);
   }
   if(cls==='pala'){
    [-1,1].forEach(v=>{const wing=new THREE.Mesh(new THREE.PlaneGeometry(strong?.42:.3,strong?1.24:.84),summary.style.glow);wing.position.set(v*.46,1.24,.2);wing.rotation.y=Math.PI;wing.rotation.z=-v*.36;add(wing);animateY(wing,strong?.08:.05,1.7);});
    const halo=new THREE.Mesh(new THREE.TorusGeometry(strong?.52:.4,.03,8,26),summary.style.glow);halo.rotation.x=Math.PI/2;halo.position.set(0,2.16,0);add(halo);animateRot(halo,strong?2.9:2.1);
   }
   addFlux({x:0,y:1.18,z:.18},summary.style,strong?34:20,strong?.22:.15);addFlux({x:0,y:1.56,z:.06},summary.style,strong?20:12,strong?.18:.12);
  };
const addEliteLegend=(slot,style)=>{
   if(style.rank<3)return;
   const wingMat=style.glow, trim=style.trim;
   if(slot==='Head'){
    if(cls==='flame'){const crown=new THREE.Mesh(new THREE.TorusGeometry(.44,.032,8,28),wingMat);crown.rotation.x=Math.PI/2;crown.position.set(0,2.38,0);add(crown);animateRot(crown,2.2);}
    if(cls==='shadow'){[-1,1].forEach(v=>{const horn=new THREE.Mesh(new THREE.BoxGeometry(.06,.28,.14),trim);horn.position.set(v*.24,2.28,0);horn.rotation.z=-v*.55;add(horn,trim,.8,.16,2.6);});}
    if(cls==='storm'){const ring=new THREE.Mesh(new THREE.TorusGeometry(.42,.028,8,24),wingMat);ring.rotation.x=Math.PI/2;ring.position.set(0,2.42,0);add(ring);animateRot(ring,2.9);}
    if(cls==='wind'){[-1,1].forEach(v=>{const ribbon=new THREE.Mesh(new THREE.PlaneGeometry(.08,.34),wingMat);ribbon.position.set(v*.16,2.32,0);ribbon.rotation.z=-v*.18;add(ribbon);animateY(ribbon,.03,1.8);});}
    if(cls==='soul'){const crown=new THREE.Mesh(new THREE.TorusKnotGeometry(.12,.024,42,6),wingMat);crown.position.set(0,2.36,0);add(crown);animateRot(crown,2.4);}
    if(cls==='sage'){[-1,1].forEach(v=>{const petal=new THREE.Mesh(new THREE.ConeGeometry(.06,.22,6),trim);petal.position.set(v*.16,2.34,0);petal.rotation.z=v*.25;add(petal,trim,.74,.14,2.1);});}
    if(cls==='pala'){const halo=new THREE.Mesh(new THREE.TorusGeometry(.44,.032,8,28),wingMat);halo.rotation.x=Math.PI/2;halo.position.set(0,2.44,0);add(halo);animateRot(halo,2.3);}
   }
   if(slot==='Shoulders'){
    [-1,1].forEach(v=>{const shard=new THREE.Mesh(new THREE.ConeGeometry(.06,.34,5),trim);shard.position.set(v*.64,1.72,0);shard.rotation.z=-v*.66;add(shard,trim,.78,.14,2.8);});
    if(cls==='flame'||cls==='storm'||cls==='soul'){[-1,1].forEach(v=>{const orbit=new THREE.Mesh(new THREE.TorusGeometry(.11,.018,6,16),wingMat);orbit.position.set(v*.56,1.58,0);orbit.rotation.y=Math.PI/2;add(orbit);animateRot(orbit,2.6);});}
   }
   if(slot==='Chest'){
    const seal=new THREE.Mesh(new THREE.TorusGeometry(.24,.026,8,22),wingMat);seal.position.set(0,1.22,-.33);add(seal);animateRot(seal,2.2);
    const veil=new THREE.Mesh(new THREE.CircleGeometry(.18,18),wingMat);veil.position.set(0,1.22,-.30);add(veil);animateY(veil,.03,2.0);
    if(cls==='flame'||cls==='storm'){const core=new THREE.Mesh(new THREE.OctahedronGeometry(.09),trim);core.position.set(0,1.22,-.34);add(core,trim,.92,.18,3.3);addFlux({x:0,y:1.22,z:-.32},style,10,.08);}
    if(cls==='shadow'){const sig=new THREE.Mesh(new THREE.BoxGeometry(.08,.26,.04),trim);sig.position.set(0,1.22,-.34);sig.rotation.z=.78;add(sig,trim,.84,.16,2.8);addFlux({x:0,y:1.22,z:-.32},style,10,.08);}
    if(cls==='wind'||cls==='sage'){const bloom=new THREE.Mesh(new THREE.TorusKnotGeometry(.07,.018,36,5),wingMat);bloom.position.set(0,1.22,-.33);add(bloom);animateRot(bloom,2.2);addFlux({x:0,y:1.22,z:-.31},style,10,.08);}
    if(cls==='soul'){const eye=new THREE.Mesh(new THREE.OctahedronGeometry(.1),trim);eye.position.set(0,1.22,-.34);add(eye,trim,.94,.18,3.1);addFlux({x:0,y:1.22,z:-.31},style,12,.08);}
    if(cls==='pala'){const crossV=new THREE.Mesh(new THREE.BoxGeometry(.04,.2,.03),trim);crossV.position.set(0,1.22,-.34);add(crossV,trim,.82,.16,2.4);const crossH=new THREE.Mesh(new THREE.BoxGeometry(.14,.04,.03),trim);crossH.position.set(0,1.2,-.34);add(crossH,trim,.82,.16,2.4);addFlux({x:0,y:1.22,z:-.31},style,10,.08);}
   }
   if(slot==='Back'){
    if(cls==='flame'||cls==='storm'||cls==='shadow'||cls==='soul'){[-1,1].forEach(v=>{const stream=new THREE.Mesh(new THREE.PlaneGeometry(.15,.72),wingMat);stream.position.set(v*.22,.96,.24);stream.rotation.y=Math.PI;stream.rotation.z=-v*.1;add(stream);animateY(stream,.04,1.6);});}
    if(cls==='wind'||cls==='sage'||cls==='pala'){[-1,1].forEach(v=>{const wing=new THREE.Mesh(new THREE.PlaneGeometry(.24,.62),wingMat);wing.position.set(v*.34,1.02,.24);wing.rotation.y=Math.PI;wing.rotation.z=-v*.25;add(wing);animateY(wing,.04,1.8);});}
   }
   if(slot==='Weapon'){
    const aura=new THREE.Mesh(new THREE.TorusGeometry(.18,.024,8,22),wingMat);aura.position.set(.84,1.44,0);aura.rotation.y=Math.PI/2;add(aura);animateRot(aura,2.8);
    const auraEcho=new THREE.Mesh(new THREE.TorusGeometry(.28,.018,8,22),wingMat);auraEcho.position.set(.84,1.44,0);auraEcho.rotation.y=Math.PI/2;add(auraEcho);animateRot(auraEcho,-2.2);
    addFlux({x:.84,y:1.44,z:0},style,14,.12);
   }
   if(slot==='Feet'){[-1,1].forEach(v=>{const rune=new THREE.Mesh(new THREE.CircleGeometry(.09,12),wingMat);rune.position.set(v*.16,-.13,0);rune.rotation.x=-Math.PI/2;add(rune);animateRot(rune,1.8);});}
  };
const addMythicLegend=(slot,style)=>{
   if(style.rank<4)return;
   const wingMat=style.glow, trim=style.trim;
   if(slot==='Head'){
    const halo=new THREE.Mesh(new THREE.TorusGeometry(.52,.038,8,30),wingMat);halo.rotation.x=Math.PI/2;halo.position.set(0,2.52,0);add(halo);animateRot(halo,2.6);
    if(cls==='flame'){[-1,1].forEach(v=>{const plume=new THREE.Mesh(new THREE.ConeGeometry(.08,.52,6),trim);plume.position.set(v*.22,2.66,0);plume.rotation.z=-v*.3;add(plume,trim,.9,.18,3.2);});}
    if(cls==='shadow'){[-1,1].forEach(v=>{const bat=new THREE.Mesh(new THREE.BoxGeometry(.08,.42,.18),trim);bat.position.set(v*.3,2.52,0);bat.rotation.z=-v*.85;add(bat,trim,.82,.16,2.9);});}
    if(cls==='storm'){const spire=new THREE.Mesh(new THREE.OctahedronGeometry(.12),trim);spire.position.set(0,2.72,0);add(spire,trim,.92,.18,3.6);}
    if(cls==='wind'){const ribbon=new THREE.Mesh(new THREE.TorusKnotGeometry(.13,.024,36,6),trim);ribbon.position.set(0,2.56,0);add(ribbon,trim,.76,.16,2.8);animateRot(ribbon,2.8);}
    if(cls==='soul'){[-1,1].forEach(v=>{const horn=new THREE.Mesh(new THREE.ConeGeometry(.07,.42,5),trim);horn.position.set(v*.28,2.62,0);horn.rotation.z=v*.55;add(horn,trim,.92,.18,3.1);});}
    if(cls==='sage'){[-1,1].forEach(v=>{const leaf=new THREE.Mesh(new THREE.ConeGeometry(.08,.34,6),trim);leaf.position.set(v*.22,2.62,0);leaf.rotation.z=v*.35;add(leaf,trim,.8,.16,2.7);});}
    if(cls==='pala'){const crest=new THREE.Mesh(new THREE.BoxGeometry(.06,.42,.16),trim);crest.position.set(0,2.7,0);add(crest,trim,.86,.16,3.0);}
   }
   if(slot==='Shoulders'){
    [-1,1].forEach(v=>{const shard=new THREE.Mesh(new THREE.ConeGeometry(.09,.72,5),trim);shard.position.set(v*.78,1.8,0);shard.rotation.z=-v*.7;add(shard,trim,.86,.18,3.1);});
    if(cls==='pala'||cls==='sage'){[-1,1].forEach(v=>{const wing=new THREE.Mesh(new THREE.PlaneGeometry(.22,.56),wingMat);wing.position.set(v*.82,1.62,.05);wing.rotation.z=-v*.45;add(wing);animateY(wing,.04,2.1);});}
   }
   if(slot==='Chest'){
    const core=new THREE.Mesh(new THREE.TorusGeometry(.28,.032,8,26),wingMat);core.position.set(0,1.22,-.39);add(core);animateRot(core,2.2);
    const star=new THREE.Mesh(new THREE.OctahedronGeometry(.12),trim);star.position.set(0,1.22,-.4);add(star,trim,1.0,.2,3.8);
    if(cls==='flame'||cls==='storm'||cls==='soul'){addFlux({x:0,y:1.22,z:-.39},style,16,.11);}
   }
   if(slot==='Back'){
    [-1,1].forEach(v=>{const wing=new THREE.Mesh(new THREE.PlaneGeometry(.46,1.12),wingMat);wing.position.set(v*.44,1.05,.24);wing.rotation.y=Math.PI;wing.rotation.z=-v*.28;add(wing);animateY(wing,.05,1.8);});
    const spine=new THREE.Mesh(new THREE.PlaneGeometry(.18,.92),wingMat);spine.position.set(0,1.0,.26);spine.rotation.y=Math.PI;add(spine);animateY(spine,.04,1.5);
   }
   if(slot==='Weapon'){
    const aura=new THREE.Mesh(new THREE.TorusGeometry(.18,.024,8,22),wingMat);aura.position.set(.84,1.44,0);aura.rotation.y=Math.PI/2;add(aura);animateRot(aura,3.4);
    const aura2=new THREE.Mesh(new THREE.TorusGeometry(.26,.02,8,22),wingMat);aura2.position.set(.84,1.44,0);aura2.rotation.x=Math.PI/2;add(aura2);animateRot(aura2,2.6);
    addFlux({x:.84,y:1.44,z:0},style,28,.18);
   }
   if(slot==='Waist'){
    const ring=new THREE.Mesh(new THREE.TorusGeometry(.47,.02,8,24),wingMat);ring.rotation.x=Math.PI/2;ring.position.y=.84;add(ring);animateRot(ring,2.4);
   }
   if(slot==='Legs'){
    [-1,1].forEach(v=>{const panel=new THREE.Mesh(new THREE.PlaneGeometry(.14,.5),wingMat);panel.position.set(v*.14,.34,-.12);add(panel);animateY(panel,.03,1.6);});
   }
   if(slot==='Feet'){
    [-1,1].forEach(v=>{const rune=new THREE.Mesh(new THREE.CircleGeometry(.12,14),wingMat);rune.position.set(v*.16,-.13,0);rune.rotation.x=-Math.PI/2;add(rune);animateRot(rune,2.1);});
   }
   if(slot==='Ring'||slot==='Trinket'||slot==='Neck'||slot==='Wrist'){
    const orb=new THREE.Mesh(new THREE.OctahedronGeometry(.06),trim);
    const pos=slot==='Neck'?{x:0,y:1.56,z:-.28}:slot==='Trinket'?{x:-.64,y:1.46,z:0}:slot==='Ring'?{x:0,y:1.18,z:0}:{x:.54,y:.88,z:0};
    orb.position.set(pos.x,pos.y,pos.z);add(orb,trim,.92,.18,3.1);addFlux(pos,style,10,.09);
   }
  };
  const styles={};bySlot.forEach((item,slot)=>styles[slot]=makeStyle(item));

  // Generic slot accents first.
  if(bySlot.has('Head')){
   const s=styles.Head;
   if(cls==='flame'){[-1,1].forEach(v=>{const horn=new THREE.Mesh(new THREE.ConeGeometry(.06,.22+.04*s.rank,6),s.trim);horn.position.set(v*.22,2.33,0);horn.rotation.z=-v*.45;add(horn,s.trim,.62,.16,2.8);});}
   if(cls==='shadow'){const hood=new THREE.Mesh(new THREE.CylinderGeometry(.26,.34,.36,8,1,true),s.cloth);hood.position.set(0,2.12,0);add(hood,s.cloth,.22,.08,1.2);const visor=new THREE.Mesh(new THREE.BoxGeometry(.28,.06,.08),s.trim);visor.position.set(0,2.07,-.25);add(visor,s.trim,.42,.1,1.9);}
   if(cls==='storm'){const spike=new THREE.Mesh(new THREE.ConeGeometry(.055,.32,5),s.trim);spike.position.y=2.48;add(spike,s.trim,.64,.16,2.9);}
   if(cls==='wind'){const knot=new THREE.Mesh(new THREE.OctahedronGeometry(.08),s.trim);knot.position.set(0,2.28,-.1);add(knot,s.trim,.46,.12,2.1);}
   if(cls==='soul'){[-1,1].forEach(v=>{const horn=new THREE.Mesh(new THREE.ConeGeometry(.055,.3+.05*s.rank,5),s.trim);horn.position.set(v*.18,2.36,0);horn.rotation.z=v*.35;add(horn,s.trim,.62,.16,2.6);});const veil=new THREE.Mesh(new THREE.CylinderGeometry(.25,.31,.30,8,1,true),s.cloth);veil.position.set(0,2.12,0);add(veil,s.cloth,.22,.08,1.2);}
   if(cls==='sage'){[-1,0,1].forEach(v=>{const leaf=new THREE.Mesh(new THREE.ConeGeometry(.05,.18,6),s.trim);leaf.position.set(v*.12,2.33,0);leaf.rotation.z=v*.35;add(leaf,s.trim,.48,.12,1.9);});}
   if(cls==='pala'){const crest=new THREE.Mesh(new THREE.BoxGeometry(.05,.28,.12),s.trim);crest.position.set(0,2.38,0);add(crest,s.trim,.48,.14,2.2);}
   addFlux({x:0,y:2.22,z:0},s,6,.08);
  }
  if(bySlot.has('Shoulders')){
   const s=styles.Shoulders;addShoulderPad(-.47,1.54,s,cls);addShoulderPad(.47,1.54,s,cls);
  }
  if(bySlot.has('Chest')){
   const s=styles.Chest,k=1+(s.rank-1)*.10;
   const addShell=(mainMat=s.plate)=>{
    const shell=new THREE.Mesh(new THREE.CylinderGeometry(.31*k,.39*k,.92*k,12,1,true),mainMat);shell.position.set(0,1.14,.01);add(shell,mainMat,s.rank>=3?.38:.16,s.rank>=3?.11:.05,1.8);
    const breast=new THREE.Mesh(new THREE.BoxGeometry(.46*k,.44*k,.11*k),mainMat);breast.position.set(0,1.23,-.21);add(breast,mainMat,s.rank>=3?.46:.20,s.rank>=3?.12:.06,2.0);
    const gorget=new THREE.Mesh(new THREE.BoxGeometry(.28*k,.14*k,.08*k),s.trim);gorget.position.set(0,1.50,-.12);add(gorget,s.trim,.42,.10,1.9);
    const fauld=new THREE.Mesh(new THREE.BoxGeometry(.34*k,.18*k,.10*k),mainMat);fauld.position.set(0,.78,-.18);add(fauld,mainMat,s.rank>=3?.40:.18,s.rank>=3?.10:.05,1.6);
    [-1,1].forEach(v=>{const side=new THREE.Mesh(new THREE.BoxGeometry(.07*k,.46*k,.07*k),s.trim);side.position.set(v*.22,1.16,-.09);add(side,s.trim,.36,.09,1.7);});
   };
   if(cls==='flame'){
    addShell(s.cloth);
    const crest=new THREE.Mesh(new THREE.ConeGeometry(.18*k,.46*k,7),s.plate);crest.position.set(0,1.22,-.39);add(crest,s.plate,.56,.15,2.4);
    const heart=new THREE.Mesh(new THREE.OctahedronGeometry(.12*k),s.trim);heart.position.set(0,1.34,-.45);add(heart,s.trim,.92,.22,3.1);
    [-1,1].forEach(v=>{const plume=new THREE.Mesh(new THREE.ConeGeometry(.065*k,.26*k,6),s.trim);plume.position.set(v*.18,1.40,-.39);plume.rotation.z=-v*.28;add(plume,s.trim,.74,.16,2.7);});
   }
   if(cls==='shadow'){
    addShell(s.dark);
    [-1,1].forEach(v=>{const diagonal=new THREE.Mesh(new THREE.BoxGeometry(.09*k,.56*k,.06*k),s.plate);diagonal.position.set(v*.11,1.16,-.39);diagonal.rotation.z=v*.46;add(diagonal,s.plate,.44,.11,2.0);});
    const eye=new THREE.Mesh(new THREE.OctahedronGeometry(.10*k),s.trim);eye.position.set(0,1.26,-.45);add(eye,s.trim,.78,.18,2.8);
   }
   if(cls==='storm'){
    addShell(s.plate);
    [-1,1].forEach(v=>{const rail=new THREE.Mesh(new THREE.BoxGeometry(.10*k,.48*k,.06*k),s.trim);rail.position.set(v*.20,1.16,-.40);add(rail,s.trim,.50,.12,2.2);});
    const core=new THREE.Mesh(new THREE.OctahedronGeometry(.13*k),s.trim);core.position.set(0,1.29,-.47);add(core,s.trim,1.02,.22,3.2);
    const arcRing=new THREE.Mesh(new THREE.TorusGeometry(.19*k,.022*k,8,20),s.glow);arcRing.position.set(0,1.29,-.47);add(arcRing);animateRot(arcRing,2.8);
   }
   if(cls==='wind'){
    addShell(s.cloth);
    [-1,1].forEach(v=>{const wrap=new THREE.Mesh(new THREE.BoxGeometry(.34*k,.07*k,.06*k),s.trim);wrap.position.set(v*.03,1.17+v*.10,-.39);wrap.rotation.z=v*.16;add(wrap,s.trim,.44,.11,1.9);});
    const med=new THREE.Mesh(new THREE.TorusGeometry(.11*k,.024*k,7,18),s.trim);med.position.set(0,1.27,-.45);add(med,s.trim,.66,.15,2.2);
    const tassel=new THREE.Mesh(new THREE.PlaneGeometry(.10*k,.36*k),s.cloth);tassel.position.set(0,.73,-.30);add(tassel,s.cloth,.24,.07,1.6);
   }
   if(cls==='soul'){
    addShell(s.dark);
    [-1,1].forEach(v=>{const rib=new THREE.Mesh(new THREE.TorusGeometry(.18*k,.024*k,6,16,Math.PI),s.trim);rib.position.set(v*.05,1.27,-.41);rib.rotation.z=v*1.03;add(rib,s.trim,.54,.13,2.3);});
    addOrb(0,1.27,-.47,.10*k,s);addFlux({x:0,y:1.27,z:-.47},s,10,.09);
   }
   if(cls==='sage'){
    addShell(s.cloth);
    [-1,0,1].forEach(v=>{const petal=new THREE.Mesh(new THREE.ConeGeometry(.085*k,.24*k,7),s.trim);petal.position.set(v*.13,1.22,-.40);petal.rotation.z=v*.34;add(petal,s.trim,.56,.12,2.1);});
    const bloom=new THREE.Mesh(new THREE.TorusKnotGeometry(.10*k,.022*k,42,7),s.glow);bloom.position.set(0,1.32,-.46);add(bloom);animateRot(bloom,2.2);
   }
   if(cls==='pala'){
    addShell(s.plate);
    [-1,1].forEach(v=>{const flank=new THREE.Mesh(new THREE.BoxGeometry(.12*k,.48*k,.07*k),s.trim);flank.position.set(v*.21,1.16,-.42);add(flank,s.trim,.50,.12,2.1);});
    const crossV=new THREE.Mesh(new THREE.BoxGeometry(.06*k,.28*k,.04*k),s.trim);crossV.position.set(0,1.29,-.47);add(crossV,s.trim,.78,.17,2.5);
    const crossH=new THREE.Mesh(new THREE.BoxGeometry(.18*k,.06*k,.04*k),s.trim);crossH.position.set(0,1.26,-.47);add(crossH,s.trim,.78,.17,2.5);
   }
   if(s.rank>=3)addFlux({x:0,y:1.16,z:-.34},s,s.rank===4?20:12,s.rank===4?.14:.10);
  }
  if(bySlot.has('Back')){
   const s=styles.Back;
   if(cls==='flame'){const cape=addCloak(s,1.05,.62,.24);cape.userData.swing=.18;}
   if(cls==='shadow'){const shroud=addCloak(s,.82,.58,.22);shroud.userData.swing=.1;const tail=new THREE.Mesh(new THREE.PlaneGeometry(.18,.56),s.cloth);tail.position.set(0,.72,.28);tail.rotation.y=Math.PI;add(tail,s.cloth,.18,.07,1.4);}
   if(cls==='storm'){const capeL=new THREE.Mesh(new THREE.PlaneGeometry(.22,.88),s.cloth);capeL.position.set(-.18,.96,.25);capeL.rotation.y=Math.PI;add(capeL,s.cloth,.22,.08,1.5);const capeR=capeL.clone();capeR.position.x=.18;add(capeR,s.cloth,.22,.08,1.6);}
   if(cls==='wind'){const longCape=addCloak(s,s.rank>=3?1.34:1.14,s.rank>=3?.62:.48,.27);longCape.userData.swing=s.rank>=3?.26:.18;[-1,1].forEach(v=>{const ribbon=new THREE.Mesh(new THREE.PlaneGeometry(s.rank>=3?.12:.09,s.rank>=3?.98:.74),s.cloth);ribbon.position.set(v*(s.rank>=3?.18:.13),s.rank>=3?1.0:.98,.24);ribbon.rotation.y=Math.PI;ribbon.rotation.z=v*(s.rank>=3?.08:.05);add(ribbon,s.cloth,.22,.09,2.0);});const crest=new THREE.Mesh(new THREE.TorusGeometry(s.rank>=3?.12:.095,s.rank>=3?.024:.02,6,18),s.trim);crest.position.set(0,1.41,.22);add(crest,s.trim,.48,.12,2.0);if(s.rank>=3){const splitL=new THREE.Mesh(new THREE.PlaneGeometry(.18,1.02),s.cloth);splitL.position.set(-.18,.92,.29);splitL.rotation.y=Math.PI;splitL.rotation.z=-.05;add(splitL,s.cloth,.28,.1,2.1);const splitR=splitL.clone();splitR.position.x=.18;splitR.rotation.z=.05;add(splitR,s.cloth,.28,.1,2.0);addFlux({x:0,y:.98,z:.24},s,s.rank===4?14:9,s.rank===4?.12:.09);}}
   if(cls==='soul'){const veil=addCloak(s,.95,.56,.26);veil.userData.swing=.16;const wisp=addOrb(0,.92,.22,.06,s);}
   if(cls==='sage'){const leafCape=new THREE.Mesh(new THREE.PlaneGeometry(.48,.84),s.cloth);leafCape.position.set(0,.97,.25);leafCape.rotation.y=Math.PI;add(leafCape,s.cloth,.18,.07,1.3);const top=new THREE.Mesh(new THREE.TorusGeometry(.18,.026,6,16),s.trim);top.position.set(0,1.45,.21);add(top,s.trim,.36,.1,1.8);}
   if(cls==='pala'){const royal=addCloak(s,1.1,.66,.26);royal.userData.swing=.2;const clasp=new THREE.Mesh(new THREE.TorusGeometry(.18,.026,6,16),s.trim);clasp.position.set(0,1.46,.2);add(clasp,s.trim,.44,.12,1.9);}
   addFlux({x:0,y:.95,z:.22},s,s.rank>=4?12:(s.rank===3?9:6),s.rank>=3?.12:.09);if(s.rank>=3)addFlux({x:0,y:1.28,z:.21},s,s.rank===4?10:7,s.rank===4?.10:.08);
  }
  if(bySlot.has('Gloves')){
   const s=styles.Gloves;addBracer(-.56,.77,s,cls);addBracer(.56,.77,s,cls);
  }
  if(bySlot.has('Waist')){
   const s=styles.Waist,shape=(cls==='flame'||cls==='wind'||cls==='sage')?'cloth':(cls==='pala'?'plate':'gem');
   addBeltPanel(s,shape,cls);
  }
  if(bySlot.has('Legs')){
   const s=styles.Legs,k=1+(s.rank-1)*.10;
   [-1,1].forEach(v=>{
    const thigh=new THREE.Mesh(new THREE.BoxGeometry(.18*k,.43*k,.18*k),s.plate);thigh.position.set(v*.16,.38,-.10);thigh.rotation.z=-v*.04;add(thigh,s.plate,s.rank>=3?.44:.20,s.rank>=3?.12:.06,1.8);
    const knee=new THREE.Mesh(new THREE.OctahedronGeometry(.075*k),s.trim);knee.position.set(v*.16,.18,-.22);add(knee,s.trim,.50,.12,2);
   });
   if(cls==='flame'){const tabard=new THREE.Mesh(new THREE.PlaneGeometry(.27*k,.57*k),s.cloth);tabard.position.set(0,.45,-.24);add(tabard,s.cloth,.30,.08,1.5);const flame=new THREE.Mesh(new THREE.ConeGeometry(.06*k,.22*k,6),s.trim);flame.position.set(0,.42,-.28);add(flame,s.trim,.62,.14,2.5);}
   if(cls==='shadow'){[-1,1].forEach(v=>{const blade=new THREE.Mesh(new THREE.BoxGeometry(.045*k,.31*k,.05),s.trim);blade.position.set(v*.28,.36,-.16);blade.rotation.z=v*.32;add(blade,s.trim,.50,.12,2.2);});}
   if(cls==='storm'){[-1,1].forEach(v=>{const arc=new THREE.Mesh(new THREE.TorusGeometry(.10*k,.018*k,6,15),s.glow);arc.position.set(v*.16,.34,-.21);arc.rotation.y=Math.PI/2;add(arc);animateRot(arc,2.4);});}
   if(cls==='wind'){[-1,1].forEach(v=>{const wrap=new THREE.Mesh(new THREE.TorusGeometry(.105*k,.02*k,6,16),s.trim);wrap.position.set(v*.16,.35,-.2);wrap.rotation.y=Math.PI/2;add(wrap);});const sash=new THREE.Mesh(new THREE.PlaneGeometry(.13*k,.45*k),s.cloth);sash.position.set(0,.43,-.23);add(sash,s.cloth,.24,.07,1.6);}
   if(cls==='soul'){const tatter=new THREE.Mesh(new THREE.PlaneGeometry(.30*k,.53*k),s.cloth);tatter.position.set(0,.43,-.23);add(tatter,s.cloth,.32,.09,1.6);addFlux({x:0,y:.42,z:-.25},s,9,.08);}
   if(cls==='sage'){[-1,1].forEach(v=>{const leaf=new THREE.Mesh(new THREE.ConeGeometry(.065*k,.24*k,6),s.trim);leaf.position.set(v*.19,.39,-.22);leaf.rotation.z=v*.36;add(leaf,s.trim,.46,.11,2);});const leafTab=new THREE.Mesh(new THREE.PlaneGeometry(.22*k,.49*k),s.cloth);leafTab.position.set(0,.44,-.22);add(leafTab,s.cloth,.25,.07,1.5);}
   if(cls==='pala'){const fauld=new THREE.Mesh(new THREE.BoxGeometry(.31*k,.22*k,.10*k),s.trim);fauld.position.set(0,.58,-.27);add(fauld,s.trim,.46,.11,2);[-1,1].forEach(v=>{const plate=new THREE.Mesh(new THREE.BoxGeometry(.12*k,.34*k,.08*k),s.trim);plate.position.set(v*.18,.36,-.23);add(plate,s.trim,.42,.1,1.9);});}
  }
  if(bySlot.has('Feet')){
   const s=styles.Feet;addBoot(-.16,s,cls);addBoot(.16,s,cls);
  }
  if(bySlot.has('Weapon')){
   const s=styles.Weapon, mythic=s.rank>=4, elite=s.rank===3;
   const addLegendGlow=(x,y,z=.0)=>{if(s.rank>=3)addFlux({x,y,z},s,s.rank===4?20:10,s.rank===4?.16:.10);};
   if(cls==='flame'){
    if(mythic){
     const shaft=new THREE.Mesh(new THREE.CylinderGeometry(.04,.05,1.42,8),s.trim);shaft.position.set(.75,1.10,0);shaft.rotation.z=-.28;add(shaft,s.trim,.42,.14,2.0);
     const crown=new THREE.Mesh(new THREE.TorusGeometry(.16,.028,8,18),s.trim);crown.position.set(.92,1.71,0);crown.rotation.y=Math.PI/2;add(crown,s.trim,.84,.18,2.6);animateRot(crown,2.2);
     const heart=new THREE.Mesh(new THREE.OctahedronGeometry(.18),s.trim);heart.position.set(.92,1.71,0);add(heart,s.trim,1.15,.25,3.2);
     [-1,1].forEach(v=>{const wing=new THREE.Mesh(new THREE.ConeGeometry(.11,.42,7),s.trim);wing.position.set(.92+v*.13,1.78,0);wing.rotation.z=-v*.72;add(wing,s.trim,.9,.18,2.9);});
     const emberTail=new THREE.Mesh(new THREE.ConeGeometry(.07,.28,6),s.trim);emberTail.position.set(.62,.48,0);emberTail.rotation.z=.22;add(emberTail,s.trim,.7,.16,2.5);addLegendGlow(.92,1.71,0);
    }else if(elite){
     const shaft=new THREE.Mesh(new THREE.BoxGeometry(.06,1.02,.06),s.trim);shaft.position.set(.75,1.08,0);shaft.rotation.z=-.22;add(shaft,s.trim,.38,.12,1.8);
     const crystal=new THREE.Mesh(new THREE.OctahedronGeometry(.18),s.trim);crystal.position.set(.88,1.57,0);add(crystal,s.trim,.88,.22,3.0);const ring=new THREE.Mesh(new THREE.TorusGeometry(.12,.02,6,16),s.glow);ring.position.set(.88,1.57,0);add(ring);animateRot(ring,2.2);addLegendGlow(.88,1.57,0);
    }else{
     const shaft=new THREE.Mesh(new THREE.BoxGeometry(.06,.86,.06),s.trim);shaft.position.set(.74,1.08,0);shaft.rotation.z=-.18;add(shaft,s.trim,.36,.12,1.8);
     const crystal=new THREE.Mesh(new THREE.OctahedronGeometry(.13+.02*s.rank),s.trim);crystal.position.set(.84,1.51,0);add(crystal,s.trim,.74,.2,3.2);addLegendGlow(.84,1.51,0);
    }
   }
   if(cls==='shadow'){
    if(mythic){
     [[.79,1.06,.10,.82,.72],[.63,.93,-.10,.72,-.72]].forEach(([x,y,z,len,rot])=>{const core=new THREE.Mesh(new THREE.BoxGeometry(.07,len,.12),s.trim);core.position.set(x,y,z);core.rotation.z=rot;add(core,s.trim,.58,.14,2.1);const edge=new THREE.Mesh(new THREE.ConeGeometry(.06,.34,5),s.trim);edge.position.set(x+.13,y+.22,z);edge.rotation.z=rot+1.55;add(edge,s.trim,.82,.18,2.6);});
     const veil=new THREE.Mesh(new THREE.TorusGeometry(.14,.022,6,18),s.glow);veil.position.set(.72,1.05,0);veil.rotation.y=Math.PI/2;add(veil);animateRot(veil,2.6);addLegendGlow(.72,1.05,0);
    }else if(elite){
     addBlade(.79,1.08,.05,.72,s,1);addBlade(.65,.96,-.05,.62,s,-1);const orb=new THREE.Mesh(new THREE.OctahedronGeometry(.09),s.trim);orb.position.set(.72,1.18,0);add(orb,s.trim,.72,.16,2.3);
    }else{
     addBlade(.75,1.07,.04,.56,s,1);addBlade(.67,.95,-.04,.48,s,-1);
    }
   }
   if(cls==='storm'){
    if(mythic){
     const haft=new THREE.Mesh(new THREE.CylinderGeometry(.035,.04,1.36,8),s.trim);haft.position.set(.74,1.08,0);haft.rotation.z=-.24;add(haft,s.trim,.4,.13,2.0);
     [-1,1].forEach(v=>{const prong=new THREE.Mesh(new THREE.BoxGeometry(.05,.34,.05),s.trim);prong.position.set(.90+v*.07,1.65+v*.05,0);prong.rotation.z=-v*.55;add(prong,s.trim,.7,.15,2.4);});
     const core=new THREE.Mesh(new THREE.OctahedronGeometry(.16),s.trim);core.position.set(.90,1.64,0);add(core,s.trim,1.05,.24,3.1);
     const ring=new THREE.Mesh(new THREE.TorusGeometry(.21,.026,8,20),s.glow);ring.position.set(.90,1.64,0);ring.rotation.y=Math.PI/2;add(ring);animateRot(ring,3.0);
     const lower=new THREE.Mesh(new THREE.OctahedronGeometry(.10),s.trim);lower.position.set(.60,.48,0);add(lower,s.trim,.72,.16,2.3);addLegendGlow(.90,1.64,0);
    }else if(elite){
     const rod=new THREE.Mesh(new THREE.BoxGeometry(.05,1.0,.05),s.trim);rod.position.set(.73,1.06,0);rod.rotation.z=-.18;add(rod,s.trim,.36,.12,1.8);
     const coil=new THREE.Mesh(new THREE.TorusGeometry(.16,.024,6,18),s.glow);coil.position.set(.84,1.48,0);coil.rotation.y=Math.PI/2;add(coil);animateRot(coil,2.8);
     const spark=new THREE.Mesh(new THREE.OctahedronGeometry(.13),s.trim);spark.position.set(.84,1.48,0);add(spark,s.trim,.82,.2,3.0);addLegendGlow(.84,1.48,0);
    }else{
     const rod=new THREE.Mesh(new THREE.BoxGeometry(.05,.92,.05),s.trim);rod.position.set(.73,1.06,0);rod.rotation.z=-.16;add(rod,s.trim,.36,.12,1.8);
     const coil=new THREE.Mesh(new THREE.TorusGeometry(.13,.022,6,18),s.glow);coil.position.set(.83,1.45,0);coil.rotation.y=Math.PI/2;add(coil);animateRot(coil,3);const spark=new THREE.Mesh(new THREE.OctahedronGeometry(.10),s.trim);spark.position.set(.83,1.45,0);add(spark,s.trim,.76,.2,3.2);
    }
   }
   if(cls==='wind'){
    if(mythic){
     const core=new THREE.Mesh(new THREE.BoxGeometry(1.22,.10,.14),s.trim);core.position.set(.78,1.06,0);core.rotation.z=-.22;add(core,s.trim,.52,.14,1.8);
     [-1,1].forEach(v=>{const hubX=.78+v*.55, hubY=1.06+v*.12;const bladeA=new THREE.Mesh(new THREE.BoxGeometry(.32,.10,.08),s.plate);bladeA.position.set(hubX,hubY,0);bladeA.rotation.z=-.22+v*.78;add(bladeA,s.plate,.62,.16,2.2);const bladeB=new THREE.Mesh(new THREE.BoxGeometry(.32,.10,.08),s.plate);bladeB.position.set(hubX,hubY,0);bladeB.rotation.z=-.22-v*.78;add(bladeB,s.plate,.62,.16,2.2);const fan=new THREE.Mesh(new THREE.TorusGeometry(.18,.045,6,18),s.glow);fan.position.set(hubX,hubY,0);fan.rotation.y=Math.PI/2;add(fan);animateRot(fan,2.3);});
     const jadeCore=new THREE.Mesh(new THREE.OctahedronGeometry(.12),s.trim);jadeCore.position.set(.78,1.06,0);add(jadeCore,s.trim,1.0,.22,3.1);addLegendGlow(.78,1.06,0);
    }else if(elite){
     const staff=new THREE.Mesh(new THREE.CylinderGeometry(.038,.038,1.12,8),s.trim);staff.position.set(.75,1.06,0);staff.rotation.z=-.26;add(staff,s.trim,.34,.1,1.6);
     [-1,1].forEach(v=>{const crescent=new THREE.Mesh(new THREE.TorusGeometry(.12,.02,6,16,Math.PI),s.glow);crescent.position.set(.85+v*.18,1.33+v*.14,0);crescent.rotation.z=v*1.2;crescent.rotation.y=Math.PI/2;add(crescent);animateRot(crescent,2.2);});addLegendGlow(.85,1.33,0);
    }else{
     const staff=new THREE.Mesh(new THREE.CylinderGeometry(.032,.032,1.0,8),s.trim);staff.position.set(.74,1.06,0);staff.rotation.z=-.28;add(staff,s.trim,.32,.1,1.6);
     [-.18,.18].forEach(v=>{const ring=new THREE.Mesh(new THREE.TorusGeometry(.1,.018,6,16),s.glow);ring.position.set(.82+v*.16,1.32+v*.25,0);ring.rotation.y=Math.PI/2;add(ring);animateRot(ring,2.2);});
    }
   }
   if(cls==='soul'){
    if(mythic){
     const haft=new THREE.Mesh(new THREE.CylinderGeometry(.032,.04,1.12,8),s.dark);haft.position.set(.74,1.03,0);haft.rotation.z=-.28;add(haft,s.dark,.1,.04,1.2);
     const blade=new THREE.Mesh(new THREE.TorusGeometry(.24,.035,6,18,Math.PI*1.12),s.trim);blade.position.set(.92,1.56,0);blade.rotation.z=1.12;add(blade,s.trim,.86,.18,2.6);
     const eye=new THREE.Mesh(new THREE.OctahedronGeometry(.16),s.trim);eye.position.set(.84,1.42,0);add(eye,s.trim,1.02,.22,3.0);
     const grimoire=new THREE.Mesh(new THREE.BoxGeometry(.22,.28,.08),s.plate);grimoire.position.set(.58,.76,.04);grimoire.rotation.y=-.5;add(grimoire,s.plate,.46,.12,2.0);addLegendGlow(.84,1.42,0);
    }else if(elite){
     const stem=new THREE.Mesh(new THREE.BoxGeometry(.05,.86,.05),s.dark);stem.position.set(.73,1.03,0);stem.rotation.z=-.18;add(stem);
     const lantern=new THREE.Mesh(new THREE.OctahedronGeometry(.18),s.trim);lantern.position.set(.83,1.42,0);add(lantern,s.trim,.82,.18,2.7);addLegendGlow(.83,1.42,0);
    }else{
     const stem=new THREE.Mesh(new THREE.BoxGeometry(.05,.82,.05),s.dark);stem.position.set(.73,1.03,0);stem.rotation.z=-.18;add(stem);const lantern=new THREE.Mesh(new THREE.OctahedronGeometry(.15),s.trim);lantern.position.set(.83,1.42,0);add(lantern,s.trim,.72,.18,2.7);
    }
   }
   if(cls==='sage'){
    if(mythic){
     const staff=new THREE.Mesh(new THREE.CylinderGeometry(.035,.045,1.34,8),s.trim);staff.position.set(.74,1.08,0);staff.rotation.z=-.22;add(staff,s.trim,.36,.1,1.6);
     const bloom=new THREE.Mesh(new THREE.TorusKnotGeometry(.14,.03,52,8),s.trim);bloom.position.set(.90,1.67,0);bloom.scale.set(1.0,1.25,1.0);add(bloom,s.trim,.86,.18,2.5);animateRot(bloom,2.1);
     [-1,1].forEach(v=>{const leaf=new THREE.Mesh(new THREE.ConeGeometry(.08,.28,6),s.trim);leaf.position.set(.90+v*.10,1.74,0);leaf.rotation.z=-v*.55;add(leaf,s.trim,.64,.14,2.2);});addLegendGlow(.90,1.67,0);
    }else if(elite){
     const branch=new THREE.Mesh(new THREE.CylinderGeometry(.03,.04,.98,7),s.trim);branch.position.set(.73,1.06,0);branch.rotation.z=-.22;add(branch,s.trim,.28,.09,1.4);const bloom=new THREE.Mesh(new THREE.TorusKnotGeometry(.11,.022,48,6),s.trim);bloom.position.set(.84,1.45,0);bloom.scale.set(.95,1.25,.95);add(bloom,s.trim,.66,.16,2.2);
    }else{
     const branch=new THREE.Mesh(new THREE.CylinderGeometry(.03,.04,.92,7),s.trim);branch.position.set(.73,1.06,0);branch.rotation.z=-.22;add(branch,s.trim,.28,.09,1.4);const bloom=new THREE.Mesh(new THREE.TorusKnotGeometry(.09,.02,48,6),s.trim);bloom.position.set(.84,1.42,0);bloom.scale.set(.9,1.2,.9);add(bloom,s.trim,.56,.14,2.2);
    }
   }
   if(cls==='pala'){
    if(mythic){
     const handle=new THREE.Mesh(new THREE.CylinderGeometry(.038,.045,1.22,8),s.trim);handle.position.set(.76,1.02,0);handle.rotation.z=-.18;add(handle,s.trim,.34,.1,1.4);
     const head=new THREE.Mesh(new THREE.BoxGeometry(.40,.24,.22),s.plate);head.position.set(.92,1.58,0);add(head,s.plate,.62,.15,2.0);
     const halo=new THREE.Mesh(new THREE.TorusGeometry(.15,.026,6,18),s.glow);halo.position.set(.92,1.58,0);add(halo);animateRot(halo,2.4);
     const shield=new THREE.Mesh(new THREE.CylinderGeometry(.42,.42,.10,10),s.plate);shield.rotation.z=Math.PI/2;shield.position.set(.34,1.16,0);add(shield,s.plate,.52,.14,2.0);
     [-1,1].forEach(v=>{const wing=new THREE.Mesh(new THREE.BoxGeometry(.08,.34,.16),s.trim);wing.position.set(.34+v*.11,1.28,0);wing.rotation.z=-v*.55;add(wing,s.trim,.64,.15,2.2);});addLegendGlow(.92,1.58,0);
    }else if(elite){
     const handle=new THREE.Mesh(new THREE.CylinderGeometry(.032,.032,.82,8),s.trim);handle.position.set(.74,1.0,0);handle.rotation.z=-.14;add(handle,s.trim,.28,.09,1.4);const head=new THREE.Mesh(new THREE.BoxGeometry(.30,.20,.16),s.plate);head.position.set(.88,1.40,0);add(head,s.plate,.50,.13,1.9);const glow=new THREE.Mesh(new THREE.TorusGeometry(.12,.022,6,14),s.glow);glow.position.set(.88,1.40,0);add(glow);animateRot(glow,2.5);
    }else{
     const handle=new THREE.Mesh(new THREE.CylinderGeometry(.03,.03,.7,8),s.trim);handle.position.set(.74,1.0,0);handle.rotation.z=-.14;add(handle,s.trim,.28,.09,1.4);const head=new THREE.Mesh(new THREE.BoxGeometry(.25,.18,.14),s.plate);head.position.set(.86,1.36,0);add(head,s.plate,.44,.12,1.9);const glow=new THREE.Mesh(new THREE.TorusGeometry(.10,.02,6,14),s.glow);glow.position.set(.86,1.36,0);add(glow);animateRot(glow,2.5);
    }
   }
  }
  if(bySlot.has('Ring')){
   const s=styles.Ring;
   const ring=new THREE.Mesh(new THREE.TorusGeometry(.46,.02,8,24),s.glow);ring.rotation.x=Math.PI/2;ring.position.y=1.18;add(ring);animateRot(ring,1.8);addFlux({x:0,y:1.18,z:0},s,6,.07);
  }
  if(bySlot.has('Trinket')){
   const s=styles.Trinket;
   if(cls==='flame')addOrb(-.64,1.44,0,.07,s);
   if(cls==='shadow')addOrb(-.62,1.32,0,.07,s);
   if(cls==='storm')addOrb(-.66,1.5,0,.07,s);
   if(cls==='wind')addOrb(-.6,1.42,0,.07,s);
   if(cls==='soul')addOrb(-.6,1.38,0,.08,s);
   if(cls==='sage')addOrb(-.62,1.47,0,.07,s);
   if(cls==='pala')addOrb(-.64,1.46,0,.07,s);
  }
  if(bySlot.has('Neck')){
   const s=styles.Neck;const amulet=new THREE.Mesh(new THREE.TorusGeometry(.09,.018,6,14),s.trim);amulet.position.set(0,1.55,-.28);add(amulet,s.trim,.38,.1,1.8);
   const gem=new THREE.Mesh(new THREE.OctahedronGeometry(.05+.015*s.rank),s.trim);gem.position.set(0,1.47,-.3);add(gem,s.trim,.62,.16,2.5);
  }
  if(bySlot.has('Wrist')){
   const s=styles.Wrist;addBracer(-.52,.91,s,cls);addBracer(.52,.91,s,cls);
  }

  bySlot.forEach((item,slot)=>addEliteLegend(slot,styles[slot]));
  bySlot.forEach((item,slot)=>addMythicLegend(slot,styles[slot]));
  const rankSummary={maxRank:0,eliteCount:0,mythicCount:0,style:null};
  bySlot.forEach((item,slot)=>{
   const r=styles[slot].rank;
   if(r>rankSummary.maxRank||!rankSummary.style){rankSummary.maxRank=r;rankSummary.style=styles[slot];}
   if(r>=3)rankSummary.eliteCount++;
   if(r>=4)rankSummary.mythicCount++;
  });
  addClassIdentitySet(rankSummary);
  addAscensionAura(rankSummary);
  group.userData.tick=(dt)=>{
   const t=performance.now()*0.001;
   animations.forEach(a=>{
    if(a.type==='rot')a.obj.rotation.y+=dt*a.speed;
    else if(a.type==='y')a.obj.position.y=a.baseY+Math.sin(t*a.speed)*a.amp;
   });
   glowTracks.forEach(g=>{g.mat.emissiveIntensity=g.base+Math.sin(t*g.speed)*g.amp;});
  };
  model.add(group);return group;
 }
 previewCatalogueSet(encoded){
  const [cls,slot,ilvlRaw]=encoded.split('|');this.armouryTransmog={classKey:cls,slot,ilvl:Number(ilvlRaw)};
  $('#loadoutClass').value=cls;this.selectArmouryClass(cls);this.renderArmoury();
 }
 clearTransmogPreview(){this.armouryTransmog=null;this.selectArmouryClass($('#loadoutClass').value);this.renderArmoury();}
 selectArmouryClass(cls){
  if(!CLASS_INFO[cls])return;
  if($('#loadoutClass').value!==cls)$('#loadoutClass').value=cls;
  if(!this.armouryRenderer)this.initArmouryPreview();
  if(this.armouryModel)this.armouryScene.remove(this.armouryModel);
  this.armouryModel=this.buildGuideModel(cls);const shownGear=this.gearAppearanceItems(cls);this.applyBaseGearVisibility(this.armouryModel,shownGear);this.armouryGearAppearance=this.attachGearAppearance(this.armouryModel,cls,shownGear,true);this.armouryPrestige=buildPrestigeVisual(cls,shownGear);if(this.armouryPrestige)this.armouryModel.add(this.armouryPrestige);applyPrestigeWeaponIllusion(this.armouryModel,cls,shownGear);applyShadowmoonWeapon(this.armouryModel,shownGear);this.armouryModel.rotation.y=this.armouryYaw;this.armouryScene.add(this.armouryModel);
  const bracket=bracketKey($('#modeSelect')?.value||'2v2'),label=$('#armouryModelLabel'),badge=$('#transmogPreviewBadge');
  if(label)label.innerHTML=`<strong>${CLASS_INFO[cls].badge} ${CLASS_INFO[cls].name}</strong>${CLASS_INFO[cls].role} · ${bracket.toUpperCase()} Rating ${classRating(cls,bracket)} · drag model to rotate`;
  if(badge){if(this.armouryTransmog&&this.armouryTransmog.classKey===cls){const rarity=rarityLabel(this.armouryTransmog.ilvl);badge.classList.remove('hidden');badge.innerHTML=`<span>✨ PIECE PREVIEW · ${this.armouryTransmog.slot} · ${rarity} ilvl ${this.armouryTransmog.ilvl}</span><button onclick="game.clearTransmogPreview()">Clear Preview</button>`;}else badge.classList.add('hidden');}
 }
 previewRenderRatio(){return Math.max(.5,Math.min(devicePixelRatio||1,1.25));}
 resizePreviewRenderer(renderer,camera,canvas,kind='menu'){
  if(!renderer||!camera||!canvas)return;const w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight),ratio=this.previewRenderRatio(canvas,kind),targetW=Math.floor(w*ratio),targetH=Math.floor(h*ratio);
  if(canvas.width!==targetW||canvas.height!==targetH||Math.abs((canvas._aetherRatio||0)-ratio)>.015){renderer.setPixelRatio(ratio);renderer.setSize(w,h,false);canvas._aetherRatio=ratio;camera.aspect=w/h;camera.updateProjectionMatrix();}
 }
 updateArmouryPreview(dt){
  if(!this.armouryRenderer||$('#armoury').classList.contains('hidden'))return;
  const canvas=$('#armouryCanvas');this.resizePreviewRenderer(this.armouryRenderer,this.armouryCamera,canvas,'armoury');
  if(this.armouryPrestige?.userData?.tick)this.armouryPrestige.userData.tick(dt);if(this.armouryModel&&!this.armouryDragging){this.armouryYaw+=dt*.30;this.armouryModel.rotation.y=this.armouryYaw;}else if(this.armouryModel)this.armouryModel.rotation.y=this.armouryYaw;if(this.armouryGearAppearance?.userData?.tick)this.armouryGearAppearance.userData.tick(dt);if(this.armouryModel?.userData?.rig&&typeof AetherKit!=='undefined')AetherKit.pose(this.armouryModel.userData.rig,{motion:0,phase:0,time:performance.now()*0.001},dt);
  this.armouryRenderer.render(this.armouryScene,this.armouryCamera);
 }
 renderArmoury(){
  if($('#armoury').classList.contains('hidden')){this.refreshMenuProgress();return;}
  const high=highestArenaRating(),unlock=unlockedItemLevel(),shopCls=$('#shopClass').value||'flame',loadCls=$('#loadoutClass').value||shopCls,bracket=bracketKey($('#modeSelect')?.value||'2v2');
  if($('#shopClassArt'))$('#shopClassArt').innerHTML=classIcon(shopCls,CLASS_INFO[shopCls].badge);
  if($('#loadoutClassArt'))$('#loadoutClassArt').innerHTML=classIcon(loadCls,CLASS_INFO[loadCls].badge);
  const selectedIlvl=$('#shopIlvl').value,levels=[];for(let i=910;i<=unlock;i+=5)levels.push({value:String(i),label:`${rarityLabel(i)} · Item Level ${i}${i===unlock?' · Highest Unlocked':''}`});
  this.fillArmourySelect('#shopIlvl',levels,selectedIlvl||String(unlock));if(!levels.some(o=>o.value===$('#shopIlvl').value))$('#shopIlvl').value=String(unlock);
  const ilvl=Number($('#shopIlvl').value||unlock),cost=gearPrice(ilvl),quality=RARITY_INFO[rarityForIlvl(ilvl)];
  $('#armOverview').innerHTML=`<div class="arm-pill">💠 Valor Shards<strong>${progression.shards}</strong></div><div class="arm-pill">Highest Rating<strong>${high}</strong></div><div class="arm-pill">Unlocked Gear<strong style="color:${quality.colour}">ilvl ${unlock} / 990</strong></div><div class="arm-pill">Arena Record<strong>${progression.wins}W · ${progression.matches} Played</strong></div><div class="arm-ratings">${GEAR_CLASSES.map(c=>`<span title="${bracket.toUpperCase()} Rating">${CLASS_INFO[c].badge} ${CLASS_INFO[c].name}<b>${classRating(c,bracket)}</b></span>`).join('')}</div>`;
  $('#buyGearBtn').textContent=`Forge ${quality.name} ilvl ${ilvl} · ${cost} 💠`;$('#buyGearBtn').disabled=progression.shards<cost;
  const rec=GEAR_BUILD_INFO[shopCls];
  const warriorRating=Math.max(classRating('warrior','2v2'),classRating('warrior','3v3')),shadowmoonOwned=progression.inventory.some(item=>item.legendaryId==='shadowmoon');
  const shadowmoonShop=shopCls==='warrior'?`<div class="shadowmoon-offer"><div class="shadowmoon-title"><span>🌘</span><strong>Shadowmoon · Legendary ilvl 1000</strong></div><p>Warrior only · selected Style Stats I & II · ${Math.round(SHADOWMOON_PROC_CHANCE*100)}% chance from melee and Bladestorm hits · Chaos Bane deals ${SHADOWMOON_CHAOS_DAMAGE} split Shadow damage and grants +9% damage for 10 sec.</p><div class="shadowmoon-requirement ${warriorRating>=SHADOWMOON_RATING?'met':''}">${warriorRating>=SHADOWMOON_RATING?'✓':'🔒'} Warrior rating ${warriorRating} / ${SHADOWMOON_RATING}</div><button id="buyShadowmoonBtn" class="shadowmoon-buy" ${shadowmoonOwned||warriorRating<SHADOWMOON_RATING||progression.shards<SHADOWMOON_COST?'disabled':''}>${shadowmoonOwned?'Shadowmoon already owned':`Forge Shadowmoon · ${SHADOWMOON_COST} 💠`}</button></div>`:'';
  $('#recommendedBuild').innerHTML=`<strong>Recommended ${CLASS_INFO[shopCls].name} Build: ${rec.name}</strong>${rec.stats.map(s=>`<span class="gear-stat">+ ${s}</span>`).join(' ')}<p>${rec.text}</p><p>Custom builds are valid: choose any two style stats before forging an item.</p>${shadowmoonShop}<p class="unlock-track"><span style="color:#40c961">Green 910–915</span> · <span style="color:#408df5">Blue 920–930</span> · <span style="color:#ef5459">Red 935–945</span> · <span style="color:#c47bff">Mythical 950–990</span> · <span style="color:#ff9d3d">Legendary 1000</span></p><div class="scaling-note"><strong>Rated Rival Scaling</strong><br>When you enter an arena, allies and enemies mirror the equipped slot count and item levels of the class you play. Each bot receives recommended stats for its own class, and high-tier scaled gear displays matching prestige visuals in combat.</div>`;
  const shadowmoonBtn=$('#buyShadowmoonBtn');if(shadowmoonBtn)shadowmoonBtn.onclick=()=>this.buyShadowmoon();
  $('#armClassTabs').innerHTML=GEAR_CLASSES.map(c=>`<button class="arm-class-tab ${c===loadCls?'active':''}" data-class="${c}" title="${CLASS_INFO[c].name}">${CLASS_INFO[c].badge} ${classRating(c,bracket)}</button>`).join('');
  $('#armClassTabs').querySelectorAll('.arm-class-tab').forEach(btn=>btn.onclick=()=>{const cls=btn.dataset.class;$('#shopClass').value=cls;this.selectArmouryClass(cls);this.renderArmoury();});
  this.selectArmouryClass(loadCls);
  const totals=this.getEquippedStats(loadCls),hpBonus=Math.round((totals.Stamina||0)*.78)+Math.min(300,Math.round((totals.Vitality||0)*.50)),manaBonus=Math.min(60,Math.round((totals.Mana||0)*.18)),primaryBonus=((totals.Intellect||0)+(totals.Agility||0)+(totals.Strength||0))*.00014,versBonus=(totals.Versatility||0)*.00018,outDmg=((Math.min(.30,(totals.Power||0)*.00038)+primaryBonus+versBonus)*100).toFixed(1),outHeal=((Math.min(.30,(totals.Restoration||0)*.00038)+primaryBonus+versBonus)*100).toFixed(1),critChance=(5+Math.min(30,Math.max(0,totals['Critical Strike']||0)*.03)).toFixed(1);
  const core=this.classCoreStats(loadCls),totalStamina=core.stamina+(totals.Stamina||0),totalPrimary=core.primaryValue+(totals[core.primary]||0);$('#equippedStats').innerHTML=`<strong>${CLASS_INFO[loadCls].badge} ${CLASS_INFO[loadCls].name}</strong> · ${bracket.toUpperCase()} Rating ${classRating(loadCls,bracket)}<br><span>Core Attributes:</span> ${totalStamina} Stamina <small>(+${totals.Stamina||0} gear)</small> · ${totalPrimary} ${core.primary} <small>(+${totals[core.primary]||0} gear)</small><br>${this.formatStatLine(totals)}<br><span>Bonus Effects:</span> +${hpBonus} HP · +${manaBonus} Mana · +${outDmg}% Damage · +${outHeal}% Healing · ${critChance}% Critical Strike<div class="equipped-tools"><button id="openStatGuideBtn" class="small-arm-btn">Stat Guide</button></div>`;
  $('#equipmentLeft').innerHTML=LEFT_GEAR_SLOTS.map(slot=>this.equipmentSlotCard(loadCls,slot)).join('');
  $('#equipmentRight').innerHTML=RIGHT_GEAR_SLOTS.map(slot=>this.equipmentSlotCard(loadCls,slot)).join('');
  const allClassInventory=progression.inventory.filter(item=>item.classKey===loadCls).sort((a,b)=>b.ilvl-a.ilvl||GEAR_SLOTS.indexOf(a.slot)-GEAR_SLOTS.indexOf(b.slot));
  const equippedIds=new Set(Object.values(progression.equipped[loadCls]||{})),equippedCount=allClassInventory.filter(item=>equippedIds.has(item.id)).length,bagCount=allClassInventory.length-equippedCount,inventoryFilter=this.inventoryFilter||'all';
  const classInventory=allClassInventory.filter(item=>inventoryFilter==='equipped'?equippedIds.has(item.id):inventoryFilter==='bag'?!equippedIds.has(item.id):true);
  document.querySelectorAll('[data-inventory-filter]').forEach(btn=>btn.classList.toggle('active',btn.dataset.inventoryFilter===inventoryFilter));
  $('#inventoryHelp').innerHTML=`<div class="inventory-class-banner"><span>${CLASS_INFO[loadCls].badge} <strong>${CLASS_INFO[loadCls].name} Items</strong></span><span>${classInventory.length} shown</span></div><div class="inventory-count-line"><b>${allClassInventory.length} Total</b><b class="equipped">${equippedCount} Equipped</b><b class="bag">${bagCount} In Bag</b></div>${inventoryFilter==='equipped'?'Viewing currently equipped items.':inventoryFilter==='bag'?'Viewing unequipped items available in your bag.':'Drag an item to its matching slot, or right-click it to equip automatically.'}`;
  $('#inventoryGear').innerHTML=classInventory.length?classInventory.map(item=>this.gearCard(item,equippedIds.has(item.id),true)).join(''):`<div class="gear-empty">${inventoryFilter==='equipped'?'No items currently equipped in this loadout.':inventoryFilter==='bag'?'No unequipped items in the bag for this class.':`No ${CLASS_INFO[loadCls].name} gear yet — forge an item or win arena drops for this class.`}</div>`;
  $('#inventoryTab').classList.toggle('active',this.collectionView==='inventory');$('#catalogueTab').classList.toggle('active',this.collectionView==='catalogue');
  $('#inventoryPane').classList.toggle('hidden',this.collectionView!=='inventory');$('#cataloguePane').classList.toggle('hidden',this.collectionView!=='catalogue');
  this.renderCatalogue();this.bindArmouryInteractions();this.refreshMenuProgress();
 }
 equipmentSlotCard(cls,slot){
  const item=progression.inventory.find(it=>it.id===progression.equipped[cls]?.[slot]),rarity=item?rarityForIlvl(item.ilvl):'';
  return `<div class="equip-slot ${item?`rarity-${rarity}`:'empty'}" data-slot="${slot}" data-class="${cls}" data-icon="${SLOT_ICONS[slot]}" ${item?`data-gear="${item.id}"`:''} title="${item?item.name:slot+' slot'}">${item?`<span class="slot-item-icon">${SLOT_ICONS[slot]}</span><span class="slot-ilvl">${item.ilvl}</span>`:''}<span class="slot-label">${slot}</span></div>`;
 }
 gearCard(item,equipped=false,inventory=false){
   const values=itemStatValues(item),sell=Math.floor(item.price*.45),recraft=gearRecraftCost(item),rarity=rarityForIlvl(item.ilvl),quality=RARITY_INFO[rarity],next=gearUpgradeStep(item.ilvl),upCost=gearUpgradeCost(item),canUp=canUpgradeGear(item);
   return `<div class="gear-item rarity-${rarity} ${equipped?'gear-equipped':''}" data-gear="${item.id}" ${inventory?'draggable="true"':''}><div class="gear-top"><span class="gear-name">${item.name}</span><span class="gear-ilvl">${item.ilvl}</span></div><div class="gear-sub"><span class="gear-rarity">${quality.name}</span> · ${CLASS_INFO[item.classKey].badge} ${CLASS_INFO[item.classKey].name} · ${SLOT_ICONS[item.slot]} ${item.slot}</div><div class="gear-stats">${GEAR_STATS.filter(s=>values[s]>0).map(s=>`<span class="gear-stat">+${values[s]} ${s}</span>`).join('')}</div>${item.legendaryId==='shadowmoon'?'<div class="legendary-effect">Soul Fragment · Chaos Bane · Purple prestige aura</div>':''}${inventory?`<div class="gear-actions"><button class="equip" onclick="game.autoEquipGear('${item.id}')">${equipped?'Equipped':'Equip'}</button><button class="recraft" onclick="game.openRecraftGear('${item.id}')">Recraft ${recraft} 💠</button>${item.ilvl>=950&&item.ilvl<990?`<button class="equip" onclick="game.upgradeGear('${item.id}')" title="${canUp?'Upgrade this mythical piece':'Requires higher rating or max upgrade cap'}" ${canUp?'':'disabled'}>Upgrade ${next} · ${upCost} 💠</button>`:''}<button class="sell" onclick="game.sellGear('${item.id}')">Sell ${sell} 💠</button></div>`:''}</div>`;
  }
  renderCatalogue(){
  if(!$('#catalogueGear'))return;
  const cls=$('#catalogueClass').value||'all',rarity=$('#catalogueRarity').value||'all',unlock=unlockedItemLevel();
  const order={mythical:4,elite:3,rare:2,uncommon:1};
  let items=allCatalogueItems().filter(item=>(cls==='all'||item.classKey===cls)&&(rarity==='all'||rarityForIlvl(item.ilvl)===rarity));
  items.sort((a,b)=>GEAR_CLASSES.indexOf(a.classKey)-GEAR_CLASSES.indexOf(b.classKey)||order[rarityForIlvl(b.ilvl)]-order[rarityForIlvl(a.ilvl)]||b.ilvl-a.ilvl||GEAR_SLOTS.indexOf(a.slot)-GEAR_SLOTS.indexOf(b.slot));
  $('#catalogueGear').innerHTML=items.map(item=>{const r=rarityForIlvl(item.ilvl),q=RARITY_INFO[r],locked=item.ilvl>unlock,encoded=`${item.classKey}|${item.slot}|${item.ilvl}`;return `<div class="gear-item rarity-${r} catalogue-item" data-catalogue="${encoded}"><div class="gear-top"><span class="gear-name">${item.name}</span><span class="gear-ilvl">${item.ilvl}</span></div><div class="gear-sub"><span class="gear-rarity">${q.name}</span> · ${CLASS_INFO[item.classKey].badge} ${CLASS_INFO[item.classKey].name} · ${SLOT_ICONS[item.slot]} ${item.slot}</div><div class="catalogue-lock">${locked?`🔒 Requires higher rating · current cap ${unlock}`:'✓ Obtainable from forge or arena wins'}</div><button class="preview-set" onclick="event.stopPropagation();game.previewCatalogueSet('${encoded}')">Preview ${SLOT_ICONS[item.slot]} ${item.slot} Mythic / Style</button></div>`;}).join('');
  document.querySelectorAll('#catalogueGear .catalogue-item').forEach(card=>{card.onmouseenter=e=>this.showCatalogueTooltip(card.dataset.catalogue,e);card.onmousemove=e=>this.positionGearTooltip(e);card.onmouseleave=()=>$('#gearTooltip').classList.add('hidden');});
 }
 classCoreStats(cls){
  const map={
   flame:{primary:'Intellect',primaryValue:126,stamina:152},
   storm:{primary:'Intellect',primaryValue:124,stamina:154},
   soul:{primary:'Intellect',primaryValue:128,stamina:150},
   sage:{primary:'Intellect',primaryValue:122,stamina:156},
   pala:{primary:'Intellect',primaryValue:120,stamina:162},
   disc:{primary:'Intellect',primaryValue:122,stamina:158},
   shadow:{primary:'Agility',primaryValue:126,stamina:154},
   wind:{primary:'Agility',primaryValue:128,stamina:156},
   warrior:{primary:'Strength',primaryValue:130,stamina:164}
  };
  return map[cls]||{primary:'Intellect',primaryValue:120,stamina:150};
 }
 openStatGuide(){const modal=$('#statGuideModal');if(modal)modal.classList.remove('hidden');}
 closeStatGuide(){const modal=$('#statGuideModal');if(modal)modal.classList.add('hidden');}
 bindArmouryInteractions(){

  document.querySelectorAll('#inventoryGear .gear-item[data-gear]').forEach(card=>{
   card.ondragstart=e=>{e.dataTransfer.setData('text/plain',card.dataset.gear);e.dataTransfer.effectAllowed='move';};
   card.oncontextmenu=e=>{e.preventDefault();this.autoEquipGear(card.dataset.gear);};
  });
  document.querySelectorAll('#armoury .equip-slot').forEach(slot=>{
   slot.ondragover=e=>{e.preventDefault();slot.classList.add('drop-ready');};
   slot.ondragleave=()=>slot.classList.remove('drop-ready','drop-invalid');
   slot.ondrop=e=>{e.preventDefault();slot.classList.remove('drop-ready','drop-invalid');const id=e.dataTransfer.getData('text/plain');this.dropGearOnSlot(id,slot.dataset.class,slot.dataset.slot);};
   slot.oncontextmenu=e=>{e.preventDefault();if(slot.dataset.gear)this.unequipSlot(slot.dataset.class,slot.dataset.slot);};
  });
  const statBtn=$('#openStatGuideBtn'),closeBtn=$('#closeStatGuide'),modal=$('#statGuideModal');
  if(statBtn)statBtn.onclick=()=>this.openStatGuide();
  if(closeBtn)closeBtn.onclick=()=>this.closeStatGuide();
  if(modal)modal.onclick=e=>{if(e.target===modal)this.closeStatGuide();};
  this.bindGearTooltipCards();
 }
 bindGearTooltipCards(){
  document.querySelectorAll('#armoury .gear-item[data-gear],#armoury .equip-slot[data-gear]').forEach(card=>{card.onmouseenter=e=>this.showGearTooltip(card.dataset.gear,e);card.onmousemove=e=>this.positionGearTooltip(e);card.onmouseleave=()=>$('#gearTooltip').classList.add('hidden');});
 }
 showGearTooltip(id,e){
  const item=progression.inventory.find(it=>it.id===id);if(!item)return;this.renderItemTooltip(item,e,progression.equipped[item.classKey]?.[item.slot]===item.id);
 }
 showCatalogueTooltip(encoded,e){
  const [cls,slot,ilvlRaw]=encoded.split('|'),ilvl=Number(ilvlRaw),build=GEAR_BUILD_INFO[cls].stats,item=createGearItem(cls,slot,ilvl,build[0],build[1],'Collection Catalogue');
  this.renderItemTooltip(item,e,false,item.ilvl>unlockedItemLevel());
 }
 renderItemTooltip(item,e,equipped=false,locked=false){
  const stats=itemStatValues(item),tt=$('#gearTooltip'),rarity=rarityForIlvl(item.ilvl),quality=RARITY_INFO[rarity];
  tt.className=`gear-tooltip rarity-${rarity}`;
  const main=CLASS_PRIMARY[item.classKey]||'Strength',coreLines=[`+${stats.Stamina||0} Stamina`,`+${stats[main]||0} ${main}`].join('<br>'),buildLines=['Power','Restoration','Vitality','Mana','Versatility','Critical Strike'].filter(s=>stats[s]>0).map(s=>`+${stats[s]} ${s}`).join('<br>');
  tt.innerHTML=`<h4>${item.name}</h4><div class="quality" style="color:${quality.colour}">${quality.name} · Item Level ${item.ilvl}</div><div class="quality">${SLOT_ICONS[item.slot]} ${item.slot} · ${CLASS_INFO[item.classKey].badge} ${CLASS_INFO[item.classKey].name}</div><div class="tipstat"><b>Core Attributes</b><br>${coreLines}<br><br><b>Build Bonuses</b><br>${buildLines}</div><p>${item.flavour}</p>${item.effect?`<p class="legendary-tooltip-effect">Equip: ${item.effect}</p>`:''}<p>${locked?'Locked: increase your highest arena rating to obtain this item level.':equipped?'Currently equipped. Right-click its slot to remove it.':'Drag to the matching equipment slot or right-click to auto-equip. Equipping this piece replaces the matching default visual on your model.'}</p><div class="selltip">${item.source==='Collection Catalogue'?'Collection Entry':`Recraft stats: ${gearRecraftCost(item)} Valor Shards · Sell value: ${Math.floor(item.price*.45)} Valor Shards`}</div>`;
  tt.classList.remove('hidden');this.positionGearTooltip(e);
 }
 positionGearTooltip(e){
  const tt=$('#gearTooltip');if(tt.classList.contains('hidden'))return;
  tt.style.left=`${clamp(e.clientX+16,10,innerWidth-305)}px`;tt.style.top=`${clamp(e.clientY+12,10,innerHeight-240)}px`;
 }
 buyGear(){
  const cls=$('#shopClass').value,slot=$('#shopSlot').value,ilvl=Number($('#shopIlvl').value),statA=$('#shopStatA').value,statB=$('#shopStatB').value,cost=gearPrice(ilvl);
  if(statA===statB){this.message('Choose two different style stats');return;}
  if(ilvl>unlockedItemLevel()){this.message('Raise rating to unlock that item level');return;}
  if(progression.shards<cost){this.message('Not enough Valor Shards');return;}
  progression.shards-=cost;const item=createGearItem(cls,slot,ilvl,statA,statB,'Quartermaster');progression.inventory.push(item);saveProgression();this.collectionView='inventory';this.renderArmoury();this.message(`${RARITY_INFO[rarityForIlvl(ilvl)].name} item forged: ${item.name}`);
 }
 buyShadowmoon(){
  const warriorRating=Math.max(classRating('warrior','2v2'),classRating('warrior','3v3'));
  const statA=$('#shopStatA').value,statB=$('#shopStatB').value;
  if(warriorRating<SHADOWMOON_RATING){this.message(`Reach ${SHADOWMOON_RATING} rating on Warrior to forge Shadowmoon`);return;}
  if(progression.inventory.some(item=>item.legendaryId==='shadowmoon')){this.message('Shadowmoon is unique and is already in your collection');return;}
  if(statA===statB){this.message('Choose two different style stats for Shadowmoon');return;}
  if(progression.shards<SHADOWMOON_COST){this.message('Not enough Valor Shards');return;}
  progression.shards-=SHADOWMOON_COST;const item=createShadowmoonItem(statA,statB);progression.inventory.push(item);saveProgression();this.collectionView='inventory';$('#loadoutClass').value='warrior';this.renderArmoury();this.message('Legendary forged: Shadowmoon · equip it in the Warrior weapon slot');
 }
 openRecraftGear(id){
  const item=progression.inventory.find(it=>it.id===id);if(!item)return;
  this.recraftItemId=id;$('#gearTooltip').classList.add('hidden');
  this.fillArmourySelect('#recraftStatA',CUSTOM_GEAR_STATS.map(s=>({value:s,label:s})),item.statA||CUSTOM_GEAR_STATS[0]);
  this.fillArmourySelect('#recraftStatB',CUSTOM_GEAR_STATS.map(s=>({value:s,label:s})),item.statB||CUSTOM_GEAR_STATS[1]);
  $('#recraftItemSummary').innerHTML=`<strong>${item.name}</strong>${RARITY_INFO[rarityForIlvl(item.ilvl)].name} · Item Level ${item.ilvl} · ${SLOT_ICONS[item.slot]} ${item.slot}<br>Current build: ${item.statA} + ${item.statB}`;
  $('#recraftStatA').onchange=()=>this.updateRecraftPreview();$('#recraftStatB').onchange=()=>this.updateRecraftPreview();
  $('#closeRecraft').onclick=()=>this.closeRecraft();$('#cancelRecraft').onclick=()=>this.closeRecraft();$('#confirmRecraft').onclick=()=>this.confirmRecraft();
  $('#recraftModal').onclick=e=>{if(e.target===$('#recraftModal'))this.closeRecraft();};
  $('#recraftModal').classList.remove('hidden');this.updateRecraftPreview();
 }
 updateRecraftPreview(){
  const item=progression.inventory.find(it=>it.id===this.recraftItemId);if(!item)return;
  const a=$('#recraftStatA').value,b=$('#recraftStatB').value,cost=gearRecraftCost(item),same=[a,b].sort().join('|')===[item.statA,item.statB].sort().join('|'),valid=a!==b&&!same;
  $('#recraftPreview').innerHTML=`<span>${item.statA} + ${item.statB}</span> → <b>${a} + ${b}</b><span class="recraft-cost">43% recraft cost · ${cost} Valor Shards</span>${a===b?'<span class="tip-bad">Choose two different stats.</span>':same?'<span class="tip-bad">Choose a different build from the current stats.</span>':''}`;
  $('#confirmRecraft').textContent=`Recraft · ${cost} 💠`;$('#confirmRecraft').disabled=!valid||progression.shards<cost;
 }
 confirmRecraft(){
  const item=progression.inventory.find(it=>it.id===this.recraftItemId);if(!item){this.closeRecraft();return;}
  const statA=$('#recraftStatA').value,statB=$('#recraftStatB').value,cost=gearRecraftCost(item);
  if(statA===statB){this.message('Choose two different style stats');return;}
  if([statA,statB].sort().join('|')===[item.statA,item.statB].sort().join('|')){this.message('Choose a different build from the current stats');return;}
  if(progression.shards<cost){this.message('Not enough Valor Shards');return;}
  progression.shards-=cost;item.statA=statA;item.statB=statB;item.source='Conquest Recraft';saveProgression();this.closeRecraft();this.renderArmoury();this.message(`${item.name} recrafted to ${statA} + ${statB}`);
 }
 closeRecraft(){this.recraftItemId=null;$('#recraftModal')?.classList.add('hidden');}
 upgradeGear(id){
   const item=progression.inventory.find(it=>it.id===id);if(!item)return;
   if(!canUpgradeGear(item)){this.message(item.ilvl>=990?'Item is already 990':'Raise rating to unlock the next upgrade tier');return;}
   const next=gearUpgradeStep(item.ilvl),cost=gearUpgradeCost(item);
   if(progression.shards<cost){this.message('Not enough Valor Shards');return;}
   progression.shards-=cost;item.ilvl=next;item.rarity=rarityForIlvl(next);item.price=gearPrice(next);item.name=gearName(item.classKey,item.slot,next);item.source='Valor Upgrade';
   saveProgression();this.renderArmoury();this.message(`${item.name} upgraded to item level ${next}`);
  }
  dropGearOnSlot(id,visibleCls,slot){
  const item=progression.inventory.find(it=>it.id===id);if(!item)return;
  if(item.classKey!==visibleCls){this.message(`Cannot equip: ${item.name} belongs to ${CLASS_INFO[item.classKey].name}`);return;}
  if(item.slot!==slot){this.message(`Cannot equip ${item.slot} item in ${slot} slot`);return;}
  progression.equipped[visibleCls][slot]=item.id;saveProgression();this.renderArmoury();this.message(`${item.name} equipped`);
 }
 autoEquipGear(id){
  const item=progression.inventory.find(it=>it.id===id);if(!item)return;
  $('#loadoutClass').value=item.classKey;this.selectArmouryClass(item.classKey);
  progression.equipped[item.classKey][item.slot]=item.id;saveProgression();this.renderArmoury();this.message(`${item.name} equipped to ${item.slot}`);
 }
 equipGear(id){this.autoEquipGear(id);}
 unequipSlot(cls,slot){
  if(!progression.equipped[cls]?.[slot])return;
  delete progression.equipped[cls][slot];saveProgression();this.renderArmoury();this.message(`${slot} unequipped`);
 }
 sellGear(id){
  const item=progression.inventory.find(it=>it.id===id);if(!item)return;
  const amount=Math.floor(item.price*.45);GEAR_CLASSES.forEach(c=>GEAR_SLOTS.forEach(slot=>{if(progression.equipped[c][slot]===id)delete progression.equipped[c][slot];}));
  progression.inventory=progression.inventory.filter(it=>it.id!==id);progression.shards+=amount;saveProgression();this.renderArmoury();this.message(`Sold for ${amount} Valor Shards`);
 }
 awardProgression(won){
  const cls=this.player.cls,mode=bracketKey(this.mode),queue=this.queueType||'ranked';
  if(queue==='training'){return {cls,mode,queueType:queue,gained:0,newRating:classRating(cls,mode),shards:0,drop:null,achievements:[],achievementShards:0};}
  let gained=0,shards=0,newRating=classRating(cls,mode),drop=null;
  progression.matches++;if(won)progression.wins++;
  if(mode==='1v1'){progression.duelMatches=(progression.duelMatches||0)+1;if(won)progression.duelWins=(progression.duelWins||0)+1;}
  if(queue==='ranked'){gained=won?(18+Math.floor(Math.random()*5)):-(10+Math.floor(Math.random()*7));shards=Math.round((won?(115+Math.floor(Math.random()*36)):(35+Math.floor(Math.random()*16)))*2.5);newRating=addClassRating(cls,mode,gained);progression.shards+=shards;if(won&&Math.random()<.60){const dropCls=cls,slot=GEAR_SLOTS[Math.floor(Math.random()*GEAR_SLOTS.length)],limit=unlockedItemLevel(),dropIlvl=Math.max(910,limit-(Math.floor(Math.random()*3)*5)),build=GEAR_BUILD_INFO[dropCls].stats;drop=createGearItem(dropCls,slot,dropIlvl,build[0],build[1],'Arena Victory Drop');progression.inventory.push(drop);}}
  else if(queue==='skirmish'||queue==='tournament'){shards=Math.round((won?(queue==='tournament'?90:38)+Math.floor(Math.random()*18):(queue==='tournament'?35:18)+Math.floor(Math.random()*10))*2.5);progression.shards+=shards;}
  const achievements=evaluateAchievements();const achievementShards=achievements.reduce((sum,a)=>sum+(a.rewardShards||0),0);
  saveProgression();return {cls,mode,queueType:queue,gained,newRating,shards,drop,achievements,achievementShards};
 }
 buildMenuClassCards(){
  const host=$('#classCards'); if(!host) return;
  const order=['flame','shadow','storm','wind','soul','sage','pala','disc','warrior'];
  const blurbs={
   flame:'Mobile fire caster with Meteorfall burst, Ember Lance payoffs and Prism Hex setup.',
   shadow:'Rogue-style melee pressure with Smoke Veil setups, Blind and strong finishing windows.',
   storm:'Elemental battlemage with proc-driven burst, Overload chains and disruptive utility.',
   wind:'Fast martial striker with Zephyr flow, Fists of Fury and ranged Incapacitate.',
   soul:'Damage-over-time affliction caster with drain pressure, roots and fast GCD pacing.',
   sage:'Nature healer with emergency recovery, Ironbark defensive saves, Lullaby Bloom control and low-pressure ranged Verdant Bolts.',
   pala:'Holy plate healer with offensive Shock, melee Righteous Strikes, Avenging Wings and Divine Steed.',
   disc:'White-robed Atonement healer who converts low damage into powerful team healing through shields, Penance and Solace.',
   warrior:'Plate melee bruiser with Charge, Rend bleeds, Pummel interrupts, Spell Reflection and a fearsome Intimidating Shout.'
  };
  host.innerHTML=order.map(cls=>`<button type="button" class="class-card" data-cls="${cls}"><div class="class-badge">${classIcon(cls,CLASS_INFO[cls].badge)}</div><div class="class-name">${CLASS_INFO[cls].name}</div><div class="class-role">${CLASS_INFO[cls].role}</div><div class="class-blurb">${blurbs[cls]}</div></button>`).join('');
  host.querySelectorAll('.class-card').forEach(card=>card.onpointerdown=()=>{$('#classSelect').value=card.dataset.cls;this.syncMenuCards();this.preview();});
  this.syncMenuCards();
 }
 syncMenuCards(){
  const selected=$('#classSelect')?.value;
  document.querySelectorAll('.class-card').forEach(card=>card.classList.toggle('active',card.dataset.cls===selected));
  if(selected)this.selectMenuChampionPreview(selected);
 }
 initMenuChampionPreview(){
  const canvas=$('#menuChampionCanvas');if(!canvas||this.menuPreviewRenderer)return;
  this.menuPreviewRenderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
  this.menuPreviewRenderer.setPixelRatio(Math.min(devicePixelRatio*1.25,2.5));
  this.menuPreviewScene=new THREE.Scene();
  this.menuPreviewCamera=new THREE.PerspectiveCamera(34,1,.1,60);
  this.menuPreviewCamera.position.set(0,2.08,6.5);this.menuPreviewCamera.lookAt(0,1.12,0);
  this.menuPreviewScene.add(new THREE.HemisphereLight(0xb9ecff,0x111824,1.38));
  const key=new THREE.DirectionalLight(0xffdb92,2.0);key.position.set(3,5,4);this.menuPreviewScene.add(key);
  const rim=new THREE.PointLight(0x4ee1ff,10,10);rim.position.set(-2.8,2.5,-1.8);this.menuPreviewScene.add(rim);
  const pedestal=new THREE.Mesh(new THREE.CylinderGeometry(1.34,1.62,.14,30),new THREE.MeshStandardMaterial({color:0x192a35,metalness:.28,roughness:.62}));pedestal.position.y=-.1;this.menuPreviewScene.add(pedestal);
  const ring=new THREE.Mesh(new THREE.RingGeometry(.84,1.05,34),new THREE.MeshBasicMaterial({color:0xe9be68,transparent:true,opacity:.55,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=-.02;this.menuPreviewScene.add(ring);
 }
 selectMenuChampionPreview(cls){
  if(!$('#menuChampionCanvas'))return;
  this.initMenuChampionPreview();if(!this.menuPreviewScene)return;
  if(this.menuPreviewModel)this.menuPreviewScene.remove(this.menuPreviewModel);
  this.menuPreviewModel=this.buildGuideModel(cls);
  const shownGear=this.getEquippedItems(cls);
  this.applyBaseGearVisibility(this.menuPreviewModel,shownGear);
  this.menuPreviewGearAppearance=this.attachGearAppearance(this.menuPreviewModel,cls,shownGear,true);
  this.menuPreviewPrestige=buildPrestigeVisual(cls,shownGear);if(this.menuPreviewPrestige)this.menuPreviewModel.add(this.menuPreviewPrestige);applyPrestigeWeaponIllusion(this.menuPreviewModel,cls,shownGear);applyShadowmoonWeapon(this.menuPreviewModel,shownGear);
  this.menuPreviewModel.rotation.y=this.menuPreviewYaw;
  this.menuPreviewScene.add(this.menuPreviewModel);
  const info=CLASS_INFO[cls],gearCount=shownGear.length;
  $('#menuChampionLabel').innerHTML=`<strong>${classIcon(cls,info.badge)} ${info.name}</strong><span>${info.role} · ${gearCount?gearCount+' equipped items':'base appearance'} · class weapon${this.menuPreviewPrestige?' · prestige active':''}</span>`;
 }
 updateMenuChampionPreview(dt){
  if(!this.menuPreviewRenderer||$('#menu').classList.contains('hidden'))return;
  const canvas=$('#menuChampionCanvas');this.resizePreviewRenderer(this.menuPreviewRenderer,this.menuPreviewCamera,canvas,'menu');
  if(this.menuPreviewGearAppearance?.userData?.tick)this.menuPreviewGearAppearance.userData.tick(dt);
  if(this.menuPreviewPrestige?.userData?.tick)this.menuPreviewPrestige.userData.tick(dt);
  if(this.menuPreviewModel){this.menuPreviewYaw+=dt*.36;this.menuPreviewModel.rotation.y=this.menuPreviewYaw;if(this.menuPreviewModel.userData?.rig&&typeof AetherKit!=='undefined')AetherKit.pose(this.menuPreviewModel.userData.rig,{motion:0,phase:0,time:performance.now()*0.001},dt);}
  this.menuPreviewRenderer.render(this.menuPreviewScene,this.menuPreviewCamera);
 }
 setArenaTheme(choice='random'){
  if(!this.arena) return;
  if(choice==='training'&&$('#queueSelect')?.value!=='training'){
   choice='random';
   if($('#arenaSelect'))$('#arenaSelect').value='random';
  }
  const picked=this.arena.setTheme(choice||'random');
  const label=$('#arenaCurrent');
  if(label){
   const source=(choice==='random'||!choice)?'Arena pool: Random · current map: ':choice==='training'?'Training destination: ':'Arena selected: ';
   label.textContent=source + this.arena.displayName;
  }
 }
 openClassGuide(cls='flame'){this.audio.ensure();$('#classGuide').classList.remove('hidden');if(!this.guideRenderer)this.initClassGuide();this.selectGuideClass(cls);}
 closeClassGuide(){$('#classGuide').classList.add('hidden');this.guideDragging=false;}
 openMountJournal(){this.selectedMountId=this.selectedMountId||progression.activeMount;this.renderMountJournal();$('#mountJournal').classList.remove('hidden');this.initMountPreview();this.setMountPreview(mountDefinition(this.selectedMountId));this.animateMountPreview();}  closeMountJournal(){$('#mountJournal').classList.add('hidden');this.mountPreviewAnimating=false;}  initMountPreview(){if(this.mountPreviewRenderer)return;const canvas=$('#mountPreviewCanvas');this.mountPreviewYaw=-.55;this.mountPreviewDragging=false;this.mountPreviewLastX=0;canvas.style.cursor='grab';canvas.title='Drag to rotate mount preview';this.mountPreviewRenderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true});this.mountPreviewRenderer.setPixelRatio(Math.min(devicePixelRatio,2));this.mountPreviewScene=new THREE.Scene();this.mountPreviewCamera=new THREE.PerspectiveCamera(42,1,.1,50);this.mountPreviewCamera.position.set(3.8,2.45,4.7);this.mountPreviewCamera.lookAt(0,1,-.15);this.mountPreviewScene.add(new THREE.HemisphereLight(0xffe5c4,0x122132,1.25));const key=new THREE.DirectionalLight(0xffe6b3,1.7);key.position.set(3,4,3);this.mountPreviewScene.add(key);const rim=new THREE.PointLight(0x7ecfff,1.3,8);rim.position.set(-2,2,-1);this.mountPreviewScene.add(rim);const ground=new THREE.Mesh(new THREE.CircleGeometry(1.85,40),new THREE.MeshStandardMaterial({color:0x25150f,roughness:.9,metalness:0}));ground.rotation.x=-Math.PI/2;this.mountPreviewScene.add(ground);canvas.addEventListener('pointerdown',e=>{this.mountPreviewDragging=true;this.mountPreviewLastX=e.clientX;canvas.style.cursor='grabbing';canvas.setPointerCapture(e.pointerId);e.preventDefault();});canvas.addEventListener('pointermove',e=>{if(!this.mountPreviewDragging)return;this.mountPreviewYaw+=(e.clientX-this.mountPreviewLastX)*.012;this.mountPreviewLastX=e.clientX;e.preventDefault();});const release=()=>{this.mountPreviewDragging=false;canvas.style.cursor='grab';};canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);}  setMountPreview(def){if(!this.mountPreviewScene)return;if(this.mountPreviewModel)this.mountPreviewScene.remove(this.mountPreviewModel);this.mountPreviewModel=buildMountVisual(def,true);this.mountPreviewModel.rotation.y=this.mountPreviewYaw??-.55;this.mountPreviewModel.position.y=.03;this.mountPreviewScene.add(this.mountPreviewModel);}  animateMountPreview(){if(this.mountPreviewAnimating)return;this.mountPreviewAnimating=true;const draw=()=>{if(!this.mountPreviewAnimating||$('#mountJournal').classList.contains('hidden')){this.mountPreviewAnimating=false;return;}const canvas=$('#mountPreviewCanvas'),w=canvas.clientWidth||420,h=canvas.clientHeight||300;this.mountPreviewRenderer.setSize(w,h,false);this.mountPreviewCamera.aspect=w/h;this.mountPreviewCamera.updateProjectionMatrix();if(this.mountPreviewModel){if(!this.mountPreviewDragging)this.mountPreviewYaw+=.0024;this.mountPreviewModel.rotation.y=this.mountPreviewYaw;const legs=this.mountPreviewModel.userData.legs||[];legs.forEach((leg,i)=>leg.rotation.x=(i%2?1:-1)*Math.sin(performance.now()*.004)*.14);this.mountPreviewModel.userData.ring.rotation.z+=.008;if(this.mountPreviewModel.userData.tickFX)this.mountPreviewModel.userData.tickFX(performance.now()*.001,.016);}this.mountPreviewRenderer.render(this.mountPreviewScene,this.mountPreviewCamera);requestAnimationFrame(draw);};requestAnimationFrame(draw);}
  showMountSkinTip(ev,text){
 let tip=$('#floatingSkinTip');
 if(!tip){tip=document.createElement('div');tip.id='floatingSkinTip';tip.className='floating-skin-tip';document.body.appendChild(tip);}
 tip.textContent=text||'';tip.style.display='block';this.moveMountSkinTip(ev);
}
moveMountSkinTip(ev){
 const tip=$('#floatingSkinTip');if(!tip)return;
 const pad=14,w=tip.offsetWidth||260,h=tip.offsetHeight||90;
 let x=ev.clientX+16,y=ev.clientY+14;
 if(x+w+pad>window.innerWidth)x=ev.clientX-w-16;
 if(y+h+pad>window.innerHeight)y=ev.clientY-h-16;
 tip.style.left=Math.max(pad,x)+'px';tip.style.top=Math.max(pad,y)+'px';
}
hideMountSkinTip(){const tip=$('#floatingSkinTip');if(tip)tip.style.display='none';}
mountSkinSelector(selected){
 const unlocked=progression.mountSkins?.[selected.id]||[];
 const active=progression.activeMountSkins?.[selected.id]||selected.defaultSkin||Object.keys(selected.skins||{})[0]||'default';
 const preview=this.previewMountSkinId||active;
 const entries=Object.entries(selected.skins||{});
 const swatches=entries.map(([id,skin])=>{
  const has=unlocked.includes(id),isActive=active===id,isPreview=preview===id;
  const bg=`linear-gradient(135deg,#${skin.body.toString(16).padStart(6,'0')},#${skin.accent.toString(16).padStart(6,'0')} 55%,#${skin.aura.toString(16).padStart(6,'0')})`;
  const tip=`${skin.label} colour scheme\n${has?'Unlocked':'Locked'}${isActive?' · Equipped':''}\n${skin.unlock||'Win the relevant challenge'}\nClick to preview`;
  return `<button class="mount-skin-swatch-btn ${has?'':'locked'} ${isActive?'active':''} ${isPreview?'previewing':''}" style="background:${bg}" data-tip="${tip}" aria-label="${tip.replace(/\n/g,' — ')}" onmouseenter="game.showMountSkinTip(event,this.dataset.tip)" onmousemove="game.moveMountSkinTip(event)" onmouseleave="game.hideMountSkinTip()" onclick="event.stopPropagation();game.previewMountSkin('${selected.id}','${id}')"></button>`;
 }).join('');
 const previewSkin=(selected.skins||{})[preview]||(selected.skins||{})[selected.defaultSkin]||Object.values(selected.skins||{})[0];
 const previewUnlocked=unlocked.includes(preview);
 return `<div class="mount-panel-box"><strong>Colour Scheme</strong><div class="mount-skin-grid">${swatches}</div><div class="mount-skin-note"><b>${previewSkin?.label||'Preview'}</b> · ${previewUnlocked?'Unlocked':'Locked'} · ${previewSkin?.unlock||'Earn this colour scheme from its source.'}</div><div class="mount-skin-preview-actions"><button class="equip" ${previewUnlocked?'':'disabled'} onclick="event.stopPropagation();game.setMountSkin('${selected.id}','${preview}')">${active===preview?'Equipped':'Equip Preview'}</button></div></div>`;
}
previewMountSkin(mountId,skinId){
 this.previewMountSkinId=skinId;
 const def=mountSkinPreviewDefinition(mountId,skinId);
 this.setMountPreview(def);
 const copy=$('#mountPreviewCopy');
 if(copy)copy.innerHTML=`<div class="rarity-chip rarity-${def.rarity}">Preview Colour</div><h3>${def.name}</h3><p>${def.skinLabel||'Colour Scheme'}</p><div class="mount-source">Preview only · unlock this colour scheme from its listed source</div>`;
 this.renderMountJournal();
}
setMountSkin(mountId,skinId){
 progression.mountSkins=progression.mountSkins||{};progression.activeMountSkins=progression.activeMountSkins||{};
 if(!(progression.mountSkins[mountId]||[]).includes(skinId)){this.message('Colour scheme locked');return;}
 progression.activeMountSkins[mountId]=skinId;this.previewMountSkinId=skinId;saveProgression();if(this.player&&progression.activeMount===mountId)this.player.createMountAppearance();this.renderMountJournal();this.refreshMenuProgress();
}
renderMountJournal(){this.hideMountSkinTip?.();progression=unlockEligibleMounts(progression);saveProgression();const query=($('#mountSearch')?.value||'').toLowerCase(),filter=$('#mountFilter')?.value||'all';let mounts=MOUNT_CATALOGUE.filter(m=>`${m.name} ${m.desc} ${m.rarityLabel}`.toLowerCase().includes(query));if(filter==='owned')mounts=mounts.filter(m=>progression.mounts.includes(m.id));else if(filter==='locked')mounts=mounts.filter(m=>!progression.mounts.includes(m.id));else if(filter==='prestige')mounts=mounts.filter(m=>m.threshold);if(!mounts.length){$('#mountList').innerHTML='<div class="mount-panel-box">No mounts match this filter.</div>';return;}if(!mounts.some(m=>m.id===this.selectedMountId))this.selectedMountId=progression.activeMount&&mounts.some(m=>m.id===progression.activeMount)?progression.activeMount:mounts[0].id;const selected=mountDefinition(this.selectedMountId),owned=progression.mounts.includes(selected.id),highest=highestArenaRating(),active=mountDefinition(progression.activeMount);$('#mountSummary').innerHTML=`<div class="mount-pill">Collected<strong>${progression.mounts.length} / ${MOUNT_CATALOGUE.length}</strong></div><div class="mount-pill">Active Mount<strong>${active.name}</strong></div><div class="mount-pill">Highest Rating<strong>${highest}</strong></div><div class="mount-pill">Prestige<strong>${progression.mounts.filter(id=>mountDefinition(id).threshold).length}</strong></div>`;$('#mountList').innerHTML=mounts.map(m=>{const has=progression.mounts.includes(m.id);return `<button class="mount-row ${m.rarity} ${m.id===selected.id?'selected':''} ${has?'':'locked'}" data-mount="${m.id}"><div class="mount-icon">${m.icon}</div><div><div class="mount-name rarity-${m.rarity}">${m.name}</div><div class="mount-meta"><span class="rarity-chip rarity-${m.rarity}">${m.rarityLabel}</span> · ${m.id==='chronocrown_protodrake'?'Aether Cup colour schemes':(m.threshold?`${m.threshold} rating reward`:'Stable mount')}</div></div><span class="mount-state ${has?'owned':''}">${m.id===progression.activeMount?'Active':has?'Owned':'Locked'}</span></button>`;}).join('');$('#mountList').querySelectorAll('[data-mount]').forEach(row=>row.onclick=()=>{this.selectedMountId=row.dataset.mount;this.previewMountSkinId=progression.activeMountSkins?.[this.selectedMountId]||'default';this.renderMountJournal();this.setMountPreview(mountDefinition(this.selectedMountId));});$('#mountPreviewCopy').innerHTML=`<div class="rarity-chip rarity-${selected.rarity}">${selected.rarityLabel}</div><h3>${selected.name}</h3><p>${selected.skinLabel?`Colour: ${selected.skinLabel}`:selected.desc}</p><div class="mount-source">${owned?'Collected':'Locked'} · ${selected.source}</div>`;$('#mountFavourite').innerHTML=`<strong>${active.name}</strong>${selected.id===active.id?'Currently active in the arena.':'Only one favourite can be summoned at a time.'}`;$('#mountBadges').innerHTML=`<span class="rarity-${selected.rarity}">${selected.rarityLabel}</span><span>${owned?'Collected':'Locked'}</span><span>${selected.id==='chronocrown_protodrake'?'Aether Cup':(selected.threshold?'Rating Reward':'Baseline Stable')}</span>${selected.skinLabel?`<span>Skin: ${selected.skinLabel}</span>`:''}`;$('#mountDescription').textContent=selected.lore;$('#mountLore').innerHTML=`${selected.lore}<br><br>Mounts now use a larger silhouette and lift the rider visibly off the floor.`;$('#mountUnlock').innerHTML=selected.id==='chronocrown_protodrake'?`<div class="mount-panel-box"><strong>Unlock Requirement</strong>Win the Aether Cup on a class to unlock that class colour scheme.</div><div class="mount-panel-box"><strong>Reward Quality</strong><span class="rarity-${selected.rarity}">${selected.rarityLabel} mount</span> with class-based colour collection.</div>${selected.skins?this.mountSkinSelector(selected):''}`:selected.threshold?`<div class="mount-panel-box"><strong>Unlock Requirement</strong>Reach ${selected.threshold} rating.</div><div class="mount-panel-box"><strong>Reward Quality</strong><span class="rarity-${selected.rarity}">${selected.rarityLabel} mount</span> with enhanced aura and particles.</div>${selected.skins&&owned?this.mountSkinSelector(selected):''}`:`<div class="mount-panel-box"><strong>Unlock Requirement</strong>Available from the start.</div><div class="mount-panel-box"><strong>Selection Rule</strong>Own many; equip one favourite.</div>${selected.skins&&owned?this.mountSkinSelector(selected):''}`;$('#mountCollector').innerHTML=`<div class="mount-panel-box"><strong>Stable Progress</strong>${progression.mounts.length} of ${MOUNT_CATALOGUE.length} collected.</div><div class="mount-panel-box"><strong>Prestige Rewards</strong>2000: Infernal Warstrider<br>2200: Aether Deathcharger<br>2400: Aether Gladiator Wyrm<br>Tournament: Chronocrown Proto-Drake colour schemes<br>2700/3000: Wyrm colour schemes</div>`;const btn=$('#equipMountBtn');btn.disabled=!owned;btn.textContent=selected.id===progression.activeMount?'Active Mount Equipped':'Set Active Mount';btn.onclick=()=>{if(!owned)return;progression.activeMount=selected.id;saveProgression();if(this.player){this.player.createMountAppearance();this.renderActions();}this.renderMountJournal();this.refreshMenuProgress();};if(this.mountPreviewScene)this.setMountPreview(selected.skins&&this.previewMountSkinId?mountSkinPreviewDefinition(selected.id,this.previewMountSkinId):selected);}  
 safeOpenTalents(cls='flame'){try{aetherBasicTalentTree(cls);return;}catch(err){console.error('Basic talent renderer failed:',err);}try{this.openTalents(cls);}catch(err){console.error('Talent UI failed:',err);this.openTalentsFallback(cls);}}
 openTalents(cls=this.player?.cls||$('#classSelect')?.value||'flame'){
  cls=TALENT_TREES[cls]?cls:'flame';this.talentClass=cls;this.selectedTalent=null;
  const modal=$('#talents');if(!modal){this.message?.('Talent panel missing');return;}
  modal.classList.remove('hidden');this.renderTalents();
 }
 openTalentsFallback(cls='flame'){
  cls=TALENT_TREES[cls]?cls:'flame';
  const modal=$('#talents'),tabs=$('#talentTabs'),tree=$('#talentTree'),info=$('#talentInfo');
  if(!modal)return;modal.classList.remove('hidden');
  if($('#talentClassLabel'))$('#talentClassLabel').textContent=CLASSES[cls]?.name||'Flame Duelist';
  if($('#talentPointsAvailable'))$('#talentPointsAvailable').textContent='-';
  if($('#talentPointsSpent'))$('#talentPointsSpent').textContent='-';
  if(tabs)tabs.innerHTML='<button class="active">Talent Tree</button>';
  if(tree)tree.innerHTML='<div style="padding:28px;color:#ffe8ad;font-weight:900">Talents are open, but the advanced renderer hit an error. Use this fixed build and report the console error if this fallback appears.</div>';
  if(info)info.innerHTML='<div class="talent-name">Talent panel opened</div><div class="talent-desc">The fallback renderer is active.</div>';
 }
 closeTalents(){this.hideTalentTip?.();$('#talents')?.classList.add('hidden');}
 renderTalents(){
  let cls=this.talentClass||$('#classSelect')?.value||'flame';cls=TALENT_TREES[cls]?cls:'flame';this.talentClass=cls;
  const tree=talentTree(cls),state=classTalentState(cls);
  const tabs=$('#talentTabs'),wrap=$('#talentTree');if(!tabs||!wrap)return;
  $('#talentClassLabel').textContent=CLASSES[cls]?.name||cls;$('#talentPointsAvailable').textContent=availableTalentPoints(cls);$('#talentPointsSpent').textContent=`${spentTalentPoints(cls)} / ${earnedTalentPoints(cls)}`;
  tabs.innerHTML=GEAR_CLASSES.map(c=>`<button class="${c===cls?'active':''}" data-talent-class="${c}"><span class="talent-class-icon">${classIcon(c,CLASSES[c]?.badge||'✦')}</span>${CLASSES[c]?.name||c}<br><small>${spentTalentPoints(c)} / ${earnedTalentPoints(c)} spent</small></button>`).join('');
  tabs.querySelectorAll('[data-talent-class]').forEach(b=>b.onclick=()=>{this.talentClass=b.dataset.talentClass;this.selectedTalent=null;this.renderTalents();});
  const lines=tree.flatMap(n=>(n.req||[]).map(req=>{const a=tree.find(x=>x.id===req);if(!a)return'';const learned=(state[n.id]||0)>0&&((state[req]||0)>0);return `<line x1="${a.x}%" y1="${a.y}%" x2="${n.x}%" y2="${n.y}%" stroke="${learned?'#7dff8b':'rgba(210,190,140,.26)'}" stroke-width="${learned?3:2}"/>`;})).join('');
  wrap.innerHTML=`<svg class="talent-lines">${lines}</svg>`+tree.map(n=>{const rank=state[n.id]||0,learned=rank>0,avail=talentNodeAvailable(cls,n);return `<button class="talent-node ${n.choice?'choice':''} ${learned?'learned':avail?'available':'locked'}" style="left:${n.x}%;top:${n.y}%;" data-talent="${n.id}"><span class="talent-icon">${talentIcon(n)}</span><span class="talent-rank">${rank}/${n.max}</span></button>`;}).join('');
  wrap.querySelectorAll('[data-talent]').forEach(btn=>{const node=tree.find(n=>n.id===btn.dataset.talent);btn.onclick=()=>{this.selectedTalent=node.id;this.renderTalentInfo();};btn.ondblclick=()=>{this.selectedTalent=node.id;this.learnSelectedTalent();};btn.onmousemove=e=>this.showTalentTip(e,node);btn.onmouseleave=()=>this.hideTalentTip();});
  this.renderTalentInfo();
 }
 showTalentTip(e,node){let tip=document.getElementById('talentTip');if(!tip){tip=document.createElement('div');tip.id='talentTip';tip.className='talent-tooltip';document.body.appendChild(tip);}const cls=this.talentClass||'flame',r=talentRank(cls,node.id);tip.style.left=Math.min(innerWidth-330,e.clientX+16)+'px';tip.style.top=Math.min(innerHeight-160,e.clientY+16)+'px';tip.innerHTML=`<h4>${talentIcon(node)} ${node.name}</h4><p>${node.desc}</p><div class="tip-rank">Rank ${r}/${node.max}${node.choice?' · Choice Node':''}</div><div class="tip-rank">Hover tooltip · Click to inspect · Double-click to learn</div>`;}
 hideTalentTip(){document.getElementById('talentTip')?.remove();}
 renderTalentInfo(){let cls=this.talentClass||$('#classSelect')?.value||'flame';cls=TALENT_TREES[cls]?cls:'flame';const tree=talentTree(cls),node=tree.find(n=>n.id===this.selectedTalent)||tree[0];this.selectedTalent=node.id;const rank=talentRank(cls,node.id),available=talentNodeAvailable(cls,node),req=(node.req||[]).map(id=>tree.find(n=>n.id===id)?.name).filter(Boolean).join(' or ');$('#talentInfo').innerHTML=`<div class="talent-name">${talentIcon(node)} ${node.name}</div><div class="talent-desc">${node.desc}</div><div class="talent-status">Rank: <strong>${rank}/${node.max}</strong><br>${node.choice?'Choice node: only one node in this branch can be active.<br>':''}${req?`Requires: ${req}<br>`:''}${available?'Click Learn to spend 1 point.':rank>=node.max?'Max rank learned.':'Locked or no points available.'}<br>${rank>0?'Right-click this node to refund one rank.':''}</div>`;$('#learnTalentBtn').disabled=!available;}
 learnSelectedTalent(){let cls=this.talentClass||$('#classSelect')?.value||'flame';cls=TALENT_TREES[cls]?cls:'flame';const node=talentTree(cls).find(n=>n.id===this.selectedTalent);if(!node||!talentNodeAvailable(cls,node))return;const state=classTalentState(cls);state[node.id]=(state[node.id]||0)+1;saveProgression();this.renderTalents();this.refreshMenuProgress();if(this.player&&this.player.cls===cls)this.float(this.player,'TALENT LEARNED','info');}
 resetTalents(){let cls=this.talentClass||$('#classSelect')?.value||'flame';cls=TALENT_TREES[cls]?cls:'flame';if(!confirm(`Reset all ${CLASSES[cls]?.name||cls} talents?`))return;progression.talents[cls]={};saveProgression();this.selectedTalent=null;this.renderTalents();this.refreshMenuProgress();}
 
 openAchievements(){this.renderAchievements();$('#achievements').classList.remove('hidden');}
 closeAchievements(){$('#achievements').classList.add('hidden');}
 renderAchievements(){const overview=$('#achievementOverview'),list=$('#achievementList'),nav=$('#achievementNav'),titleSelect=$('#achievementTitleSelect');if(!overview||!list||!nav||!titleSelect)return;const unlocked=unlockedAchievementCount(),topTitle=playerTitleLabel(),rewardTotal=achievementRewardTotal(),high=highestArenaRating();const filters=[['all','Summary'],['rating','Player vs. Player'],['wins','Arena Wins'],['titles','Titles']];const currentFilter=this.achievementFilter||'all';nav.innerHTML=filters.map(([key,label])=>`<button class="ach-nav-btn ${currentFilter===key?'active':''}" data-ach-filter="${key}">${label}</button>`).join('');nav.querySelectorAll('[data-ach-filter]').forEach(btn=>btn.onclick=()=>{this.achievementFilter=btn.dataset.achFilter;this.renderAchievements();});overview.innerHTML=`<div class="ach-pill">Achievements<strong>${unlocked} / ${ACHIEVEMENTS.length}</strong></div><div class="ach-pill">Active Title<strong>${topTitle}</strong></div><div class="ach-pill">Highest Rating<strong>${high}</strong></div><div class="ach-pill">Shard Rewards Claimed<strong>${rewardTotal.toLocaleString()}</strong></div>`;const titleCls=$('#classSelect')?.value||currentTitleClass();const titleOptions=availableAchievementTitles(titleCls);titleSelect.innerHTML=`<option value="__none__" ${progression.currentTitle==='__none__'?'selected':''}>No Title</option>${titleOptions.map(title=>`<option value="${title}" ${progression.currentTitle!=='__none__'&&equippedAchievementTitle(titleCls)===title?'selected':''}>${title}</option>`).join('')}`;titleSelect.onchange=()=>{progression.currentTitle=titleSelect.value;saveProgression();this.renderAchievements();this.refreshMenuProgress();this.message(titleSelect.value==='__none__'?'Title cleared':`Title equipped: ${titleSelect.value}`);};let defs=ACHIEVEMENTS.slice();if(currentFilter==='rating')defs=defs.filter(def=>def.type==='rating');else if(currentFilter==='wins')defs=defs.filter(def=>def.type==='wins');else if(currentFilter==='titles')defs=defs.filter(def=>!!def.title);defs.sort((a,b)=>{const au=!!progression.achievements[a.id],bu=!!progression.achievements[b.id];if(au!==bu)return au?-1:1;return (b.threshold||0)-(a.threshold||0);});const cards=defs.map(def=>{const state=progression.achievements[def.id],unlockedCls=state?'unlocked':'locked';const status=state?'Unlocked':'Locked';const when=state?.unlockedAt?new Date(state.unlockedAt).toLocaleDateString():'';const prog=achievementProgress(def);const targetText=def.type==='rating'?`Reach ${def.threshold} rating`:def.type==='tournament'?'Win the Aether Cup on each class':`Win ${def.threshold} arena rounds`;const progressText=def.type==='tournament'?`${prog.current} / ${prog.total} class clears`:state?`${targetText} complete`:def.type==='rating'?`${Math.min(prog.current,def.threshold)} / ${def.threshold} rating`:`${Math.min(prog.current,def.threshold)} / ${def.threshold} wins`;return `<div class="ach-item ${unlockedCls}"><div class="ach-top"><div class="ach-icon">${def.icon}</div><div><div class="ach-name">${def.name}</div><div class="ach-meta">${targetText}${when?` · ${when}`:''}</div></div><span class="ach-state">${status}</span></div><p class="ach-desc">${def.desc}</p><div class="ach-progress"><div class="ach-progress-bar"><span style="width:${(state&&def.type!=='tournament'?1:prog.pct)*100}%"></span></div><div class="ach-progress-text"><span>${progressText}</span><span>${Math.round((state&&def.type!=='tournament'?1:prog.pct)*100)}%</span></div></div><div class="ach-footer">${def.title?`<span class="ach-chip title-chip">Title: ${def.title}</span>${['rating','bracketRating','tournament'].includes(def.type)?`<span class="ach-chip">Classes: ${achievementClassList(def).map(c=>CLASS_INFO[c].badge).join(' ')||'None yet'}</span>`:''}`:''}${def.rewardShards?`<span class="ach-chip reward">Reward: +${def.rewardShards.toLocaleString()} Valor Shards</span>`:''}${def.rewardMount?`<span class="ach-chip reward">Mount: ${mountDefinition(def.rewardMount).name}</span>`:''}</div></div>`;}).join('');list.className='ach-list';list.innerHTML=cards||'<div class="ach-empty">No achievements available in this category.</div>';}
 queueAchievementToast(def){if(!def)return;this.achievementQueue.push(def);if(!this.achievementShowing)this.showNextAchievementToast();}
 showNextAchievementToast(){const def=this.achievementQueue.shift();if(!def){this.achievementShowing=false;return;}this.achievementShowing=true;const root=$('#achievementToastRoot');if(!root){this.achievementShowing=false;return;}const el=document.createElement('div');el.className='achievement-toast';el.innerHTML=`<div class="toast-icon">${def.icon}</div><div><div class="toast-over">Achievement Earned</div><div class="toast-name">${def.name}</div><div class="toast-meta">${def.title?`Title unlocked: ${def.title}`:'Achievement added to your collection.'}${def.rewardShards?` · +${def.rewardShards.toLocaleString()} Valor Shards`:''}${def.rewardMount?` · Mount unlocked: ${mountDefinition(def.rewardMount).name}`:''}</div></div>`;root.appendChild(el);this.audio.play('achievement');requestAnimationFrame(()=>el.classList.add('show'));setTimeout(()=>{el.classList.remove('show');setTimeout(()=>{el.remove();this.achievementShowing=false;this.showNextAchievementToast();},260);},4100);}
 initClassGuide(){const canvas=$('#guideCanvas');this.guideRenderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});this.guideRenderer.setPixelRatio(Math.min(devicePixelRatio*1.5,3));this.guideScene=new THREE.Scene();this.guideCamera=new THREE.PerspectiveCamera(38,1,.1,60);this.guideCamera.position.set(0,2.35,6.9);this.guideCamera.lookAt(0,1.25,0);const hemi=new THREE.HemisphereLight(0xaee7ff,0x111a24,1.5);this.guideScene.add(hemi);const key=new THREE.DirectionalLight(0xffda8d,2.15);key.position.set(3.5,5,4);this.guideScene.add(key);const rim=new THREE.PointLight(0x5edbff,12,12);rim.position.set(-3,2.7,-2);this.guideScene.add(rim);const platform=new THREE.Mesh(new THREE.CylinderGeometry(1.5,1.8,.18,32),new THREE.MeshStandardMaterial({color:0x253643,metalness:.32,roughness:.58}));platform.position.y=-.1;this.guideScene.add(platform);const ring=new THREE.Mesh(new THREE.RingGeometry(.95,1.16,32),new THREE.MeshBasicMaterial({color:0xf3c768,transparent:true,opacity:.58,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=.01;this.guideScene.add(ring);canvas.addEventListener('pointerdown',e=>{this.guideDragging=true;this.guideLastX=e.clientX;canvas.setPointerCapture(e.pointerId);});canvas.addEventListener('pointermove',e=>{if(!this.guideDragging)return;this.guideYaw+=(e.clientX-this.guideLastX)*.012;this.guideLastX=e.clientX;});const stop=()=>this.guideDragging=false;canvas.addEventListener('pointerup',stop);canvas.addEventListener('pointercancel',stop);}
 guideDescription(cls){return {flame:'A ranged ember mage who controls space with roots and long crowd control before setting up devastating Meteorfall burst.',shadow:'A mobile assassin who builds marks through repeated strikes, then cashes them into poison pressure and long stun windows.',storm:'A control-oriented lightning wielder who sustains mana through casts, creates Overload windows and protects itself with barriers.',wind:'A fast martial artist who chains melee procs into explosive combo sequences and a channelled area lockdown finisher.',soul:'A corruption caster who stacks volatile afflictions, protects a key channel from interrupts and siphons a target\'s remaining essence.',sage:'A mobile arena healer who stabilises allies with wards and healing while contributing crowd control through Lullaby Bloom.',pala:'A plate-clad holy healer who turns enemy burst against itself through instant shocks, sacrifice protection and powerful peel.',disc:'A white-robed battle priest who protects allies with Atonement, then converts precise holy damage into powerful team healing while keeping direct mends and suppression for emergencies.',warrior:'A relentless plate-clad frontline bruiser who charges into battle, bleeds down targets, shuts down casts with Pummel and reflects incoming magic.'}[cls];}
 selectGuideClass(cls){
  const order=['flame','shadow','storm','wind','soul','sage','pala','disc','warrior'];
  $('#guideTabs').innerHTML=order.map(k=>`<button class="guide-tab ${k===cls?'active':''}" data-cls="${k}">${classIcon(k,CLASS_INFO[k].badge)} ${CLASS_INFO[k].name}</button>`).join('');
  $('#guideTabs').querySelectorAll('.guide-tab').forEach(b=>b.onclick=()=>this.selectGuideClass(b.dataset.cls));
  const info=CLASS_INFO[cls],plan=CLASS_GAME_PLANS[cls];
  $('#guideModelLabel').innerHTML=`<strong>${classIcon(cls,info.badge)} ${info.name}</strong><span>${info.role} · drag model to rotate</span>`;
  $('#guideFlavour').textContent=this.guideDescription(cls);
  $('#guideMechanic').innerHTML=`<div class="guide-plan"><span><b>Core game plan</b>${plan.core}</span><span><b>Burst window</b>${plan.burst}</span><span><b>Survival</b>${plan.survival}</span></div>`;
  $('#guidePassives').innerHTML=`<strong>Resources & passive spell interactions</strong>${CLASS_PASSIVES[cls]}`;
  $('#guideAbilities').innerHTML=AB[cls].map((a,i)=>{const cleanTip=String(a.tip||'').replace(/^Talent ability\.\s*/,'').replace(/^(?:Caster|Storm|Melee|Healer|Holy healer|Atonement healer|Martial|Affliction|Warrior) mechanic:\s*/i,'');const costText=a.cost>0?`Costs ${a.cost} ${info.resource==='energy'?'energy':'mana'}.`:'No resource cost.';return `<div class="guide-ability"><div class="guide-ability-head"><span class="guide-ability-name">${i+1}. ${abilityIcon(a)} ${a.name}</span><span class="guide-ability-meta">${a.cast?a.cast+'s CAST':'INSTANT'} · ${a.range?a.range+'m':'SELF'} · ${a.cd?a.cd+'s CD':'NO CD'}</span></div><p>${cleanTip} <span style="color:#9ccaff">${costText}</span></p></div>`;}).join('');
  if(this.guideModel)this.guideScene.remove(this.guideModel);this.guideModel=this.buildGuideModel(cls);this.guideModel.rotation.y=this.guideYaw;this.guideScene.add(this.guideModel);
 }
 buildGuideModel(cls){
  if(typeof AetherKit!=='undefined'&&AetherKit.ready){const gm=AetherKit.buildModelGroup(cls);gm.userData.preview=true;return gm;}
  const g=new THREE.Group(),info=CLASS_INFO[cls],col=info.colour;
  const dark=new THREE.MeshStandardMaterial({color:0x28313b,metalness:.2,roughness:.55}),bodyMat=new THREE.MeshStandardMaterial({color:col,emissive:col,emissiveIntensity:.27,roughness:.38}),trim=new THREE.MeshStandardMaterial({color:0xf0c86c,emissive:0xb98c26,emissiveIntensity:.18,roughness:.38}),skin=new THREE.MeshStandardMaterial({color:0xe5ddd0,roughness:.64});
  const mark=(mesh,...slots)=>{mesh.userData.baseGearSlots=slots;return mesh;};
  const add=mesh=>{g.add(mesh);return mesh;};
  const torso=mark(add(new THREE.Mesh(new THREE.CapsuleGeometry(.39,.82,5,10),bodyMat)),'Chest');torso.position.y=1.22;
  const pelvis=mark(add(new THREE.Mesh(new THREE.CylinderGeometry(.34,.43,.4,8),bodyMat)),'Chest','Waist','Legs');pelvis.position.y=.57;
  const neck=add(new THREE.Mesh(new THREE.CylinderGeometry(.11,.12,.22,10),skin));neck.position.y=1.81;
  const face=add(new THREE.Mesh(new THREE.SphereGeometry(.29,14,12),skin));face.position.y=2.08;
  [-1,1].forEach(s=>{const arm=add(new THREE.Mesh(new THREE.CylinderGeometry(.075,.085,.62,8),dark));arm.position.set(s*.53,1.14,0);arm.rotation.z=-s*.2;const leg=add(new THREE.Mesh(new THREE.CylinderGeometry(.1,.11,.68,8),dark));leg.position.set(s*.14,.18,0);});
  if(cls==='flame'){
   const skirt=mark(add(new THREE.Mesh(new THREE.CylinderGeometry(.48,.60,.86,8,1,true),new THREE.MeshStandardMaterial({color:0x6b2f16,emissive:0xff7436,emissiveIntensity:.12,side:THREE.DoubleSide}))),'Chest','Legs');skirt.position.y=.83;
   const mantle=mark(add(new THREE.Mesh(new THREE.ConeGeometry(.36,.56,8),bodyMat)),'Head');mantle.position.y=2.42;
   const staff=mark(add(new THREE.Mesh(new THREE.CylinderGeometry(.04,.04,1.5,6),dark)),'Weapon');staff.position.set(.7,1.2,0);staff.rotation.z=.12;
   const gem=mark(add(new THREE.Mesh(new THREE.OctahedronGeometry(.18),new THREE.MeshStandardMaterial({color:0xffd164,emissive:0xff642b,emissiveIntensity:1}))),'Weapon');gem.position.set(.79,1.92,0);
  }
  if(cls==='shadow'){
   const hood=mark(add(new THREE.Mesh(new THREE.ConeGeometry(.36,.54,8),new THREE.MeshStandardMaterial({color:0x2e1749,emissive:col,emissiveIntensity:.22}))),'Head');hood.position.y=2.29;
   const cape=mark(add(new THREE.Mesh(new THREE.BoxGeometry(.62,.92,.06),new THREE.MeshStandardMaterial({color:0x21142e,transparent:true,opacity:.85}))),'Back');cape.position.set(0,1.1,-.26);
   [-1,1].forEach(s=>{const blade=mark(add(new THREE.Mesh(new THREE.BoxGeometry(.055,.6,.11),new THREE.MeshStandardMaterial({color:0xe4d5ff,emissive:col,emissiveIntensity:.46}))),'Weapon');blade.position.set(s*.7,.98,.08);blade.rotation.z=-s*.45;});
  }
  if(cls==='storm'){
   const halo=mark(add(new THREE.Mesh(new THREE.TorusGeometry(.46,.045,8,20),new THREE.MeshBasicMaterial({color:0x72eeff}))),'Shoulders');halo.rotation.x=Math.PI/2;halo.position.y=1.62;
   const orb=mark(add(new THREE.Mesh(new THREE.SphereGeometry(.17,10,8),new THREE.MeshStandardMaterial({color:0xc8fdff,emissive:col,emissiveIntensity:1}))),'Weapon');orb.position.set(.72,1.52,0);
  }
  if(cls==='wind'){
   const sash=mark(add(new THREE.Mesh(new THREE.TorusGeometry(.4,.065,8,20),trim)),'Waist');sash.rotation.x=Math.PI/2;sash.position.y=1.03;
   [-1,1].forEach(s=>{const fist=mark(add(new THREE.Mesh(new THREE.SphereGeometry(.12,8,8),new THREE.MeshStandardMaterial({color:0xffe39b,emissive:col,emissiveIntensity:.72}))),'Weapon');fist.position.set(s*.64,1.04,.05);});
  }
  if(cls==='soul'){
   const robe=mark(add(new THREE.Mesh(new THREE.CylinderGeometry(.5,.68,1.06,10,1,true),new THREE.MeshStandardMaterial({color:0x2b153b,emissive:col,emissiveIntensity:.25,side:THREE.DoubleSide}))),'Chest','Legs');robe.position.y=.82;
   const orb=mark(add(new THREE.Mesh(new THREE.SphereGeometry(.17,10,8),new THREE.MeshStandardMaterial({color:0xf2dcff,emissive:col,emissiveIntensity:1}))),'Trinket');orb.position.set(-.72,1.5,0);
   const tome=mark(add(new THREE.Mesh(new THREE.BoxGeometry(.34,.42,.08),new THREE.MeshStandardMaterial({color:0x24122d,emissive:col,emissiveIntensity:.4}))),'Weapon');tome.position.set(.68,1.32,0);
  }
  if(cls==='sage'){
   const robe=mark(add(new THREE.Mesh(new THREE.CylinderGeometry(.52,.68,1.06,10,1,true),new THREE.MeshStandardMaterial({color:0x215742,emissive:col,emissiveIntensity:.16,side:THREE.DoubleSide}))),'Chest','Legs');robe.position.y=.82;
   const staff=mark(add(new THREE.Mesh(new THREE.CylinderGeometry(.04,.04,1.42,6),dark)),'Weapon');staff.position.set(.72,1.22,0);staff.rotation.z=.14;
  }
  if(cls==='pala'){
   const armour=mark(add(new THREE.Mesh(new THREE.CylinderGeometry(.52,.67,1.08,10,1,true),new THREE.MeshStandardMaterial({color:0xd2a944,emissive:col,emissiveIntensity:.23,metalness:.34,side:THREE.DoubleSide}))),'Chest','Legs');armour.position.y=.82;
   const mantle=mark(add(new THREE.Mesh(new THREE.BoxGeometry(.92,.16,.35),trim)),'Shoulders');mantle.position.y=1.56;
   const shield=mark(add(new THREE.Mesh(new THREE.CylinderGeometry(.36,.36,.09,8),trim)),'Weapon');shield.rotation.z=Math.PI/2;shield.position.set(-.73,1.17,0);
   const hammer=mark(add(new THREE.Mesh(new THREE.CylinderGeometry(.04,.04,1.26,7),dark)),'Weapon');hammer.position.set(.72,1.16,0);hammer.rotation.z=-.18;
   const hammerHead=mark(add(new THREE.Mesh(new THREE.BoxGeometry(.37,.19,.2),trim)),'Weapon');hammerHead.position.set(.82,1.78,0);
  }
  const aura=new THREE.Mesh(new THREE.RingGeometry(.72,.89,30),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.9,side:THREE.DoubleSide}));aura.rotation.x=-Math.PI/2;aura.position.y=.02;g.add(aura);
  return g;
 }
 updateGuidePreview(dt){if(!this.guideRenderer||$('#classGuide').classList.contains('hidden'))return;const canvas=$('#guideCanvas');this.resizePreviewRenderer(this.guideRenderer,this.guideCamera,canvas,'guide');if(this.guideModel&&!this.guideDragging){this.guideYaw+=dt*.48;this.guideModel.rotation.y=this.guideYaw;}else if(this.guideModel)this.guideModel.rotation.y=this.guideYaw;if(this.guideModel?.userData?.rig&&typeof AetherKit!=='undefined')AetherKit.pose(this.guideModel.userData.rig,{motion:0,phase:0,time:performance.now()*0.001},dt);this.guideRenderer.render(this.guideScene,this.guideCamera);}
 preview(){let mode=$('#modeSelect').value,chosen=$('#classSelect').value,cls=CLASS_INFO[chosen].name,arena=this.arena?.displayName||'Random Arena';const healer=['sage','pala','disc'].includes(chosen);if(mode==='1v1'){$('#composition').innerHTML=`<strong class="blue">You:</strong> ${cls}<br><strong class="red">Opponent:</strong> Random class<br><small style="color:var(--muted)">Arena: <strong>${arena}</strong> · A straight duel. No partners, no healers, and 1v1 keeps its own rating.</small>`;this.syncMenuCards();this.refreshMenuProgress();return;}if(healer){$('#composition').innerHTML=`<strong class="blue">Your team:</strong> ${cls} + Random DPS${mode==='3v3'?' + Random DPS':''}<br><strong class="red">Enemy team:</strong> Random Healer + Matching DPS${mode==='3v3'?' + Matching DPS':''}<br><small style="color:var(--muted)">Arena: <strong>${arena}</strong> · Healer matches mirror DPS classes for fair testing.</small>`;}else{$('#composition').innerHTML=`<strong class="blue">Your team:</strong> ${cls} + Random Healer${mode==='3v3'?' + Random DPS':''}<br><strong class="red">Enemy team:</strong> Random Healer + Random DPS${mode==='3v3'?' + Random DPS':''}<br><small style="color:var(--muted)">Arena: <strong>${arena}</strong> · Enemy compositions randomise each round.</small>`;}this.syncMenuCards();this.refreshMenuProgress();}
 botDifficultyProfile(){
 const r=this.queueType==='ranked'?classRating(this.player?.cls||($('#classSelect')?.value||'flame'),bracketKey(this.mode||$('#modeSelect')?.value||'2v2')):highestArenaRating();
 if(r<1800)return {tier:'1600-1800',min:.42,max:.70,interrupt:.28,kite:.34,fakeDelay:.42};
 if(r<2000)return {tier:'1800-2000',min:.32,max:.56,interrupt:.42,kite:.48,fakeDelay:.34};
 if(r<2400)return {tier:'2000-2400',min:.23,max:.43,interrupt:.58,kite:.62,fakeDelay:.28};
 if(r<2700)return {tier:'2400-2700',min:.16,max:.32,interrupt:.74,kite:.76,fakeDelay:.22};
 return {tier:'2700+',min:.09,max:.22,interrupt:.90,kite:.88,fakeDelay:.16};
}
openTournament(){
 const classes=['flame','shadow','storm','wind','soul','sage','pala','disc','warrior'];
 const opts=classes.map(c=>`<option value="${c}">${CLASS_INFO[c].badge} ${CLASS_INFO[c].name}</option>`).join('');
 $('#tournamentClass').innerHTML=opts;
 $('#tournamentClass').value=this.tournament?.active?this.tournament.playerClass:($('#classSelect')?.value||'flame');
 $('#tournamentClass').onchange=()=>this.updateTournamentPartnerOptions();
 this.updateTournamentPartnerOptions();
 if(this.tournament?.active&&this.tournament.partnerClass)$('#tournamentPartner').value=this.tournament.partnerClass;
 const active=!!this.tournament?.active,finished=!!this.tournament?.finished,eliminated=!!this.tournament?.eliminated;
 $('#startTournamentBtn').textContent=active?'Restart Tournament':'Lock In Team & Build Bracket';
 const playBtn=$('#playTournamentBtn');
 if(playBtn){
  playBtn.classList.toggle('hidden',!active||finished);
  playBtn.textContent=active?(eliminated?'Tournament Complete':'Continue Tournament'):'Start Playing Tournament';
 }
 $('#tournamentBracketView').innerHTML=this.renderTournamentBracketHTML(false);
 $('#tournamentModal').classList.remove('hidden');
}
closeTournament(){$('#tournamentModal').classList.add('hidden');}
updateTournamentPartnerOptions(){const cls=$('#tournamentClass')?.value||'flame',healers=['sage','pala','disc'],dps=['flame','shadow','storm','wind','soul','warrior'];const partnerOptions=healers.includes(cls)?dps:dps.concat(healers);const current=$('#tournamentPartner')?.value;$('#tournamentPartner').innerHTML=partnerOptions.map(c=>`<option value="${c}">${CLASS_INFO[c].badge} ${CLASS_INFO[c].name}</option>`).join('');if(current&&partnerOptions.includes(current))$('#tournamentPartner').value=current;else $('#tournamentPartner').value=healers.includes(cls)?'warrior':'sage';const team=[$('#tournamentClass').value,$('#tournamentPartner').value];const doubleDps=team.every(c=>!healers.includes(c));$('#tournamentCompHint').innerHTML=doubleDps?'Your selected team is <strong>double DPS</strong>. This is only allowed for the player team; AI teams remain healer + DPS.':'Your selected team is <strong>healer + DPS</strong>. AI teams also use healer + DPS.';$('#tournamentPartner').onchange=()=>this.updateTournamentPartnerOptions();}
startTournament(){
 const cls=$('#tournamentClass').value,partner=$('#tournamentPartner').value,healers=['sage','pala','disc'];
 if(healers.includes(cls)&&healers.includes(partner)){this.message('Two healers are not allowed in tournament teams');return;}
 this.tournament=this.createTournamentBracket(cls,partner);
 $('#classSelect').value=cls;
 $('#modeSelect').value='2v2';
 $('#queueSelect').value='skirmish';
 this.queueType='tournament';
 this.forceTournamentStart=false;
 $('#startTournamentBtn').textContent='Restart Tournament';
 const playBtn=$('#playTournamentBtn');
 if(playBtn){playBtn.classList.remove('hidden');playBtn.textContent='Start Playing Tournament';}
 $('#tournamentBracketView').innerHTML=this.renderTournamentBracketHTML(false);
 this.message('Aether Cup bracket locked in');
}
playTournamentMatch(){
 if(!this.tournament?.active){this.startTournament();if(!this.tournament?.active)return;}
 if(this.tournament.finished){this.openTournament();return;}
 this.progressTournamentUntilPlayerReady();
 if(this.tournament.finished){this.openTournament();return;}
 this.forceTournamentStart=true;
 this.closeTournament();
 this.start();
}
tournamentSeriesTarget(){return this.tournament?.round>=3?4:3;}
tournamentRoundName(){return this.tournament?.roundNames?.[this.tournament.round]||'Tournament Match';}
tournamentTeamLabel(team){if(!team)return 'TBD';return team.classes.map(c=>`${CLASS_INFO[c].badge} ${CLASS_INFO[c].name}`).join(' + ');}
createTournamentBracket(playerClass,partnerClass){
 const healers=['sage','pala','disc'],dps=['flame','shadow','storm','wind','soul','warrior'];
 const names=['Iron Oath','Nightfall Pact','Stormforge','Verdant Guard','Ashen Crown','Soulbound','Lionheart','Runebreakers','Skyward','Duskwatch','Ember Court','Wild Tempest','Silver Root','Vanguard','Bloodmoon'];
 const teams=[{id:0,seed:1,name:'Your Team',classes:[playerClass,partnerClass],player:true}];
 const dpsOrder=this.shuffleArray(dps.concat(dps,dps));
 for(let i=1;i<16;i++){
  const healer=healers[(i-1)%healers.length],damage=dpsOrder[i-1]||dps[(i-1)%dps.length];
  teams.push({id:i,seed:i+1,name:names[i-1]||`AI Team ${i}`,classes:[healer,damage],player:false});
 }
 const roundNames=['Quarter-final','Semi-final','Contender Final','Grand Final'];
 const t={active:true,round:0,seriesWins:0,seriesLosses:0,playerClass,partnerClass,roundNames,teams,rounds:[],finished:false,eliminated:false,champion:null};
 t.rounds[0]=this.makeTournamentRound(t,0,teams.map(x=>x.id));
 this.tournament=t;
 return t;
}
makeTournamentRound(t,roundIndex,teamIds){const bestOf=roundIndex>=3?7:5;const matches=[];for(let i=0;i<teamIds.length;i+=2)matches.push({a:teamIds[i],b:teamIds[i+1],winsA:0,winsB:0,winner:null,bestOf});return {name:t.roundNames[roundIndex]||`Round ${roundIndex+1}`,bestOf,matches};}
shuffleArray(arr){return arr.slice().sort(()=>Math.random()-.5);}
getTournamentPlayerMatch(includeResolved=false){
 const t=this.tournament,r=t?.rounds?.[t.round];
 if(!t||!r)return null;
 return r.matches.find(m=>{const hasPlayer=t.teams[m.a]?.player||t.teams[m.b]?.player;return hasPlayer&&(includeResolved||m.winner===null);})||null;
}
simulateTournamentRoundStep(roundIndex=this.tournament?.round||0,gamesPerMatch=1){
 const t=this.tournament,r=t?.rounds?.[roundIndex];
 if(!t||!r)return false;
 let changed=false;
 for(let step=0;step<gamesPerMatch;step++){
  r.matches.forEach(m=>{
   if(m.winner!==null)return;
   const hasPlayer=t.teams[m.a]?.player||t.teams[m.b]?.player;
   if(hasPlayer)return;
   const target=m.bestOf>=7?4:3;
   const aPower=this.tournamentTeamPower(t.teams[m.a]),bPower=this.tournamentTeamPower(t.teams[m.b]);
   const aWins=Math.random()<(aPower/(aPower+bPower));
   if(aWins)m.winsA++;else m.winsB++;
   changed=true;
   if(m.winsA>=target||m.winsB>=target)m.winner=m.winsA>=target?m.a:m.b;
  });
 }
 return changed;
}
simulateTournamentRoundToCompletion(roundIndex=this.tournament?.round||0){
 const t=this.tournament,r=t?.rounds?.[roundIndex];
 if(!t||!r)return;
 let guard=0;
 while(r.matches.some(m=>m.winner===null)&&guard<64){this.simulateTournamentRoundStep(roundIndex,1);guard++;}
}
tournamentTeamPower(team){if(!team)return 1;const dpsBonus={flame:1.02,shadow:1.03,storm:1.02,wind:1.01,soul:1.02,warrior:1.03};const healBonus={sage:1.01,pala:1.02};return team.classes.reduce((s,c)=>s*(dpsBonus[c]||healBonus[c]||1),1)*(0.92+Math.random()*0.18);}
completeTournament(){
 const cls=this.tournament?.playerClass||this.player?.cls||$('#classSelect')?.value||'flame';
 const mountId=chronocrownMountIdForClass(cls),skinId=chronocrownSkinIdForClass(cls);
 try{
  progression.mounts=Array.isArray(progression.mounts)?progression.mounts:[];
  progression.mountSkins=progression.mountSkins||{};progression.activeMountSkins=progression.activeMountSkins||{};
  progression.tournamentCupWins=progression.tournamentCupWins||{};
  progression.tournamentCupRewarded=progression.tournamentCupRewarded||{};
  const classAlready=!!progression.tournamentCupWins[cls];
  progression.tournamentCupWins[cls]=true;
  const shardReward=progression.tournamentCupRewarded[cls]?0:22000;
  if(shardReward){progression.tournamentCupRewarded[cls]=true;progression.shards+=shardReward;}
  progression.achievements=progression.achievements||{};
  const cupAchievement=progression.achievements.tournament_champion||(progression.achievements.tournament_champion={unlockedAt:Date.now(),rewardShards:0,title:'Aether Cup Champion',rewardMount:mountId,name:'Aether Cup Champion'});
  cupAchievement.rewardShards=Number(cupAchievement.rewardShards||0)+shardReward;
  progression.achievementClasses=progression.achievementClasses||{};
  progression.achievementClasses.tournament_champion=GEAR_CLASSES.filter(c=>progression.tournamentCupWins[c]);
  if(!progression.mounts.includes(mountId))progression.mounts.push(mountId);
  const skins=progression.mountSkins[mountId]||[];
  const skinAlready=skins.includes(skinId);
  progression.mountSkins[mountId]=Array.from(new Set([...skins,skinId]));
  progression.activeMount=mountId;progression.activeMountSkins[mountId]=skinId;
  this.tournamentRewardUnlocked=!classAlready||!skinAlready;
  if(this.tournament){this.tournament.rewardUnlocked=this.tournamentRewardUnlocked;this.tournament.rewardClass=cls;this.tournament.rewardMountId=mountId;this.tournament.rewardSkinId=skinId;}
  saveProgression();
  this.queueAchievementToast?.({name:`Aether Cup Champion — ${chronocrownClassLabel(cls)}`,icon:'🏆',desc:`Won the Aether Cup as ${chronocrownClassLabel(cls)} and unlocked its title eligibility and Chronocrown Proto-Drake colour.`,rewardShards:shardReward});
  this.message(this.tournamentRewardUnlocked?`${chronocrownClassLabel(cls)} Proto-Drake colour unlocked`:`${chronocrownClassLabel(cls)} Cup clear recorded`);
 }catch(e){
  console.warn('Tournament reward unlock failed',e);
 }
}
advanceTournamentRoundIfReady(){
 const t=this.tournament;
 if(!t||t.finished)return false;
 const r=t.rounds[t.round];
 if(!r||!r.matches.every(m=>m.winner!==null))return false;
 if(t.round>=3){
  t.finished=true;
  t.champion=r.matches[0]?.winner??null;
  if(t.teams[t.champion]?.player)this.completeTournament();
  return true;
 }
 const winners=r.matches.map(m=>m.winner);
 t.round++;
 t.seriesWins=0;
 t.seriesLosses=0;
 t.rounds[t.round]=this.makeTournamentRound(t,t.round,winners);
 return true;
}
progressTournamentUntilPlayerReady(){
 const t=this.tournament;
 if(!t)return;
 let guard=0;
 while(!t.finished&&!this.getTournamentPlayerMatch()&&guard<20){
  this.simulateTournamentRoundToCompletion(t.round);
  if(!this.advanceTournamentRoundIfReady())break;
  guard++;
 }
}
simulateTournamentToChampion(){
 const t=this.tournament;
 if(!t)return;
 let guard=0;
 while(!t.finished&&guard<40){
  this.simulateTournamentRoundToCompletion(t.round);
  this.advanceTournamentRoundIfReady();
  guard++;
 }
}
recordTournamentGame(won){
 const t=this.tournament,m=this.getTournamentPlayerMatch(true);
 if(!t||!m||m.winner!==null)return;
 const playerIsA=t.teams[m.a]?.player,need=m.bestOf>=7?4:3,currentRound=t.round;
 if(won){if(playerIsA)m.winsA++;else m.winsB++;}else{if(playerIsA)m.winsB++;else m.winsA++;}
 t.seriesWins=playerIsA?m.winsA:m.winsB;
 t.seriesLosses=playerIsA?m.winsB:m.winsA;
 this.simulateTournamentRoundStep(currentRound,1);
 if(t.seriesWins>=need){
  m.winner=playerIsA?m.a:m.b;
  this.advanceTournamentRoundIfReady();
 }else if(t.seriesLosses>=need){
  m.winner=playerIsA?m.b:m.a;
  t.eliminated=true;
  this.simulateTournamentToChampion();
  if(!t.finished)t.finished=true;
 }
}
renderTournamentBracketHTML(compact=false){
 const t=this.tournament;
 if(!t?.active)return `<div class="tournament-status">No active bracket yet. Lock in a team to generate the full 16-team Aether Cup bracket.</div>`;
 const renderMatch=(m,roundIdx,slot)=>{
  const bestOf=roundIdx>=3?7:5;
  if(!m){
   return `<div class="t-match pending"><div class="t-team loser"><span><strong>TBD</strong><span class="classes">Waiting for qualifier</span></span><span class="score">-</span></div><div class="t-team loser"><span><strong>TBD</strong><span class="classes">Waiting for qualifier</span></span><span class="score">-</span></div></div>`;
  }
  const a=t.teams[m.a],b=t.teams[m.b],player=a?.player||b?.player,done=m.winner!==null;
  const row=(team,side)=>{
   const wins=side==='A'?m.winsA:m.winsB,other=side==='A'?m.winsB:m.winsA,isWinner=done&&m.winner===team?.id,isLoser=done&&!isWinner;
   const label=team?.player?'YOUR TEAM':`${team?.seed?team.seed+'. ':''}${team?.name||'TBD'}`;
   return `<div class="t-team ${team?.player?'you':''} ${isWinner?'winner':''} ${isLoser?'loser':''}"><span><strong>${label}</strong><span class="classes">${this.tournamentTeamLabel(team)}</span></span><span class="score">${wins}${done?`-${other}`:''}</span></div>`;
  };
  return `<div class="t-match ${player?'player':''}" title="${t.roundNames[roundIdx]||'Round'} ${slot+1} · Best of ${bestOf}">${row(a,'A')}${row(b,'B')}</div>`;
 };
 const col=(side,cls,title,best,matches)=>`<div class="bracket-col ${cls}"><h4>${title}<span>${best}</span></h4>${matches.map((m,i)=>`<div class="bracket-node">${renderMatch(m,cls==='cf'?2:cls==='sf'?1:0,i)}</div>`).join('')}</div>`;
 const qf=t.rounds[0]?.matches||[],sf=t.rounds[1]?.matches||[],cf=t.rounds[2]?.matches||[],gf=t.rounds[3]?.matches||[];
 const left=`<div class="bracket-side left">${col('left','qf','Left Quarter-Final','BO5',qf.slice(0,4))}${col('left','sf','Left Semi-Final','BO5',[sf[0],sf[1]])}${col('left','cf','Left Contender Final','BO5',[cf[0]])}</div>`;
 const center=`<div class="bracket-final-center"><div class="bracket-cup-title">Aether Cup Final</div><div class="final-connector"></div>${renderMatch(gf[0],3,0)}</div>`;
 const right=`<div class="bracket-side right">${col('right','cf','Right Contender Final','BO5',[cf[1]])}${col('right','sf','Right Semi-Final','BO5',[sf[2],sf[3]])}${col('right','qf','Right Quarter-Final','BO5',qf.slice(4,8))}</div>`;
 const liveMatch=this.getTournamentPlayerMatch();
 const resolvedPlayerMatch=this.getTournamentPlayerMatch(true);
 let status='Current series: '+this.tournamentRoundName()+` · ${t.seriesWins||0}-${t.seriesLosses||0}`;
 if(t.finished)status=t.teams[t.champion]?.player?'Tournament complete: your team won the Aether Cup.':`Tournament complete: ${t.teams[t.champion]?.seed?`${t.teams[t.champion].seed}. `:''}${t.teams[t.champion]?.name||'Unknown Team'} won the Aether Cup.`;
 else if(!liveMatch&&resolvedPlayerMatch&&resolvedPlayerMatch.winner!==null)status=`${this.tournamentRoundName()} complete for your team. Waiting for the remaining series to finish before your next matchup is generated.`;
 return `<div class="tournament-status">${status}</div><div class="tournament-live split ${compact?'compact':''}">${left}${center}${right}</div>`;
}
nextTournamentMatch(){
 if(!this.tournament?.active)return this.openTournament();
 if(this.tournament.finished)return this.openTournament();
 this.playTournamentMatch();
}
pickRegularDpsSet(count=1,exclude=[]){const dps=['flame','shadow','storm','wind','soul','warrior'].filter(c=>!exclude.includes(c));this.recentRegularDps=this.recentRegularDps||[];const scored=dps.map(c=>({c,score:(this.recentRegularDps.includes(c)?1:0)+Math.random()})).sort((a,b)=>a.score-b.score);const picked=scored.slice(0,count).map(x=>x.c);this.recentRegularDps=this.recentRegularDps.concat(picked).slice(-4);return picked;}
saveBinds(){localStorage.setItem('aetherBinds',JSON.stringify(binds));}
 saveAbilityLayouts(){localStorage.setItem('aetherAbilityLayouts',JSON.stringify(abilityLayouts));}
 abilitySlotIdentity(ability){
  if(!ability)return'';
  if(ability.name==='Chaos Bolt')return'Unstable Affliction';
  if(ability.name==='Immolate')return'Creeping Torment';
  return ability.name;
 }
 abilityLayoutKey(cls){return cls;}
 canonicalAbilitySlots(cls){
  const base=(window.__AB_BASE?.[cls]||AB[cls]||[]).map(a=>this.abilitySlotIdentity(a));
  const unlocked=Object.values(TALENT_UNLOCKED_ABILITIES[cls]||{}).filter(a=>a.type!=='passiveOnly').map(a=>this.abilitySlotIdentity(a));
  return [...new Set(base.concat(unlocked))].slice(0,14);
 }
 classAbilityDisplayOrder(cls){
  const defaults=this.extraToolkitDisplayOrder(cls);
  const byIdentity=new Map(defaults.map(item=>[this.abilitySlotIdentity(item.a),item]));
  const canonical=this.canonicalAbilitySlots(cls),saved=Array.isArray(abilityLayouts[cls])?abilityLayouts[cls]:[];
  const slots=Array(14).fill(null),used=new Set();
  saved.slice(0,14).forEach((name,slot)=>{const identity=name==='Chaos Bolt'?'Unstable Affliction':name==='Immolate'?'Creeping Torment':name;if(identity&&!used.has(identity)){slots[slot]=identity;used.add(identity);}});
  canonical.forEach(identity=>{if(used.has(identity))return;const empty=slots.indexOf(null);if(empty>=0){slots[empty]=identity;used.add(identity);}});
  byIdentity.forEach((item,identity)=>{if(used.has(identity))return;const empty=slots.indexOf(null);if(empty>=0){slots[empty]=identity;used.add(identity);}});
  abilityLayouts[cls]=slots.slice();
  return slots.map((identity,slot)=>identity&&byIdentity.has(identity)?{...byIdentity.get(identity),slot,slotIdentity:identity}:null);
 }
 swapAbilitySlots(fromSlot,toSlot){
  if(!this.player||fromSlot===toSlot||fromSlot<0||toSlot<0)return;
  const cls=this.player.cls;
  const ordered=this.classAbilityDisplayOrder(cls);
  if(fromSlot>=14||toSlot>=14)return;
  const names=ordered.map(item=>item?.slotIdentity||null);
  const fromName=ordered[fromSlot]?.a?.name||'Empty slot',toName=ordered[toSlot]?.a?.name||'Empty slot';
  [names[fromSlot],names[toSlot]]=[names[toSlot],names[fromSlot]];
  abilityLayouts[cls]=names;
  this.saveAbilityLayouts();
  this.renderActions();
  this.message(`${CLASS_INFO[cls].name}: ${fromName} is now ${bindLabel(binds['a'+(toSlot+1)])}; ${toName} is now ${bindLabel(binds['a'+(fromSlot+1)])}`);
 }
 start(){this.closeArmoury();this.closeAchievements();const requestedArena=$('#arenaSelect')?.value||'random';this.queueType=(this.forceTournamentStart&&this.tournament?.active)?'tournament':($('#queueSelect')?.value||'ranked');this.forceTournamentStart=false;if(this.queueType==='training'&&requestedArena!=='training')$('#arenaSelect').value='training';if(this.queueType==='ranked'&&requestedArena==='training'){$('#arenaSelect').value='random';this.message('Training Grounds is disabled for Ranked');}this.setArenaTheme($('#arenaSelect')?.value||'random');this.closeClassGuide();this.audio.ensure();this.audio.play('start');this.clear();this.cameraRig.yaw=-Math.PI/2;this.cameraRig.pitch=.34;this.cameraRig.distance=12.4;this.mode=$('#modeSelect').value;this.difficulty=$('#difficultySelect').value;if(this.renderer)this.renderer.setPixelRatio(Math.min(devicePixelRatio,this.mode==='3v3'?1.25:1.75));let cls=$('#classSelect').value;this.allyGearProfile=this.getEquippedItems(cls).map(item=>({slot:item.slot,ilvl:item.ilvl}));this.enemyGearProfile=this.getEquippedItems(cls).map(item=>({slot:item.slot,ilvl:item.ilvl}));const dps=['flame','shadow','storm','wind','soul','warrior'];const healers=['sage','pala','disc'];const shuffle=a=>a.slice().sort(()=>Math.random()-.5);const healerPick=()=>healers[Math.floor(Math.random()*healers.length)];if(this.queueType==='training'){this.spawn('You',cls,'ally',-10,0,true);const d1=this.spawn('Target Dummy','storm','enemy',7,-4);const d2=this.spawn('Training Dummy','flame','enemy',11,0);const d3=this.spawn('Cleave Dummy','shadow','enemy',7,4);[d1,d2,d3].forEach((u,i)=>{u.name=i===0?'Target Dummy':i===1?'Training Dummy':'Cleave Dummy';u.ai=null;u.trainingDummy=true;u.dummyRegen=false;u.maxHp=9000;u.hp=u.maxHp;u.resource=0;u.maxResource=0;u.combatUntil=1e9;u.moveSpeed=0;});this.target=d1;this.phase='fight';this.time=0;this.dampening=0;this.paused=false;$('#menu').classList.add('hidden');$('#hud').classList.remove('hidden');$('#overlay').classList.add('hidden');this.renderFrames();this.renderActions();this.message('Training Grounds');this.log('Training Grounds loaded: three target dummies are available for single-target and cleave practice. Dummies cannot fall below 80% health and regenerate after reaching the practice floor.');this.log('Queue Type: Training — no rating or shard rewards are awarded here.');this.refreshMenuProgress();return;}if(this.queueType==='tournament'){if(!this.tournament?.rounds?.length)this.tournament=this.createTournamentBracket(this.tournament?.playerClass||cls,this.tournament?.partnerClass||'sage');this.progressTournamentUntilPlayerReady();if(this.tournament?.finished){this.returnMenu();return;}cls=this.tournament.playerClass;const match=this.getTournamentPlayerMatch(),playerIsA=match&&this.tournament.teams[match.a]?.player,enemyTeam=match?this.tournament.teams[playerIsA?match.b:match.a]:null,enemyClasses=enemyTeam?.classes||['sage','warrior'];const enemyHeal=enemyClasses.find(c=>healers.includes(c))||'sage',enemyDps=enemyClasses.find(c=>!healers.includes(c))||'warrior';this.spawn('You',cls,'ally',-16,4,true);this.spawn('Cup Partner',this.tournament.partnerClass,'ally',-17,-4);this.spawn('Cup Healer',enemyHeal,'enemy',17,4);this.spawn('Cup Rival',enemyDps,'enemy',16,-4);this.target=this.units.find(u=>u.team==='enemy'&&!healers.includes(u.cls))||this.units.find(u=>u.team==='enemy');this.log(`Aether Cup: ${this.tournamentRoundName()} · ${this.tournamentTeamLabel(this.tournament.teams[playerIsA?match.a:match.b])} vs ${this.tournamentTeamLabel(enemyTeam)} · series ${this.tournament.seriesWins||0}-${this.tournament.seriesLosses||0}, first to ${this.tournamentSeriesTarget()} wins.`);}else if(this.mode==='1v1'){const pool=shuffle(dps.filter(d=>d!==cls)).concat(shuffle(healers.filter(h=>h!==cls)));const foe=pool[0]||'warrior';this.spawn('You',cls,'ally',-20,0,true);this.spawn('Vael',foe,'enemy',20,0);this.target=this.units.find(u=>u.team==='enemy');this.log(`Duel: ${CLASS_INFO[cls].name} versus ${CLASS_INFO[foe].name}. No partners and no healers — you win this one alone.`);}else if(healers.includes(cls)){const allyDps=this.pickRegularDpsSet(this.mode==='3v3'?2:1);let enemyDps=this.pickRegularDpsSet(this.mode==='3v3'?2:1);if(enemyDps[0]===allyDps[0]){const alt=shuffle(dps.filter(x=>x!==allyDps[0]));enemyDps[0]=alt[0]||enemyDps[0];}if(this.mode==='3v3'&&enemyDps[1]===allyDps[1]){const alt=shuffle(dps.filter(x=>!enemyDps.includes(x)&&x!==allyDps[1]));enemyDps[1]=alt[0]||enemyDps[1];}const enemyHeal=healerPick();this.spawn('You',cls,'ally',-17,-4,true);this.spawn('Aren',allyDps[0],'ally',-15,4);if(this.mode==='3v3')this.spawn('Thoren',allyDps[1],'ally',-12,0);this.spawn('Mira',enemyHeal,'enemy',17,4);this.spawn('Vael',enemyDps[0],'enemy',16,-4);if(this.mode==='3v3')this.spawn('Kaio',enemyDps[1],'enemy',12,0);this.target=this.units.find(u=>u.team==='ally'&&u!==this.player);this.log(`Healer matchup: ${CLASS_INFO[cls].name} with ${CLASS_INFO[allyDps[0]].name} versus ${CLASS_INFO[enemyHeal].name} with ${CLASS_INFO[enemyDps[0]].name}; DPS are no longer always mirrored.`);}else{const allyPool=shuffle(dps.filter(d=>d!==cls));const enemyPool=this.pickRegularDpsSet(this.mode==='3v3'?2:1);const allyHeal=healerPick(),enemyHeal=healerPick();this.spawn('You',cls,'ally',-16,4,true);this.spawn('Ayla',allyHeal,'ally',-17,-4);if(this.mode==='3v3')this.spawn('Thoren',allyPool[0],'ally',-12,0);this.spawn('Mira',enemyHeal,'enemy',17,4);this.spawn('Vael',enemyPool[0],'enemy',16,-4);if(this.mode==='3v3')this.spawn('Kaio',enemyPool[1],'enemy',12,0);this.target=this.units.find(u=>u.team==='enemy'&&!healers.includes(u.cls))||this.units.find(u=>u.team==='enemy');this.log(`Random enemy team: ${CLASS_INFO[enemyHeal].name} + ${CLASS_INFO[enemyPool[0]].name}${this.mode==='3v3'?` + ${CLASS_INFO[enemyPool[1]].name}`:''}. Warrior is included in the regular DPS pool and recent repeats are deprioritised.`);}this.phase='countdown';this.count=3;this.time=0;this.dampening=0;this.paused=false;$('#menu').classList.add('hidden');$('#hud').classList.remove('hidden');$('#overlay').classList.add('hidden');this.renderFrames();this.renderActions();this.message(this.queueType==='ranked'?'Prepare for battle':this.queueType==='tournament'?`${this.tournamentRoundName()} begins soon`:'Skirmish begins soon');this.log(`Match started: ${this.queueType.toUpperCase()} ${this.mode}${this.queueType==='tournament'?` · ${this.tournamentRoundName()}`:`, ${this.difficulty}`}.`);this.log(this.enemyGearSummary());if((this.allyGearProfile||[]).length)this.log(`Ally Scaling: your AI teammate also mirrors your ${this.allyGearProfile.length} equipped slot${this.allyGearProfile.length===1?'':'s'} using recommended stats for their own class.`);const gearStats=this.getEquippedStats(cls);if(this.getEquippedItems(cls).length)this.log(`Equipped ${CLASS_INFO[cls].name} loadout: ${this.formatStatLine(gearStats)}.`);if(this.queueType==='skirmish')this.log('Skirmish queue active: this match does not change your 1v1, 2v2 or 3v3 rating.');if(this.queueType==='tournament')this.log('Tournament bracket active: the full Aether Cup bracket is created up front, AI series update game by game on the bracket, and your current opponent team stays fixed until the series ends.');if(cls==='sage')this.log('You are the Lifesage: support your random DPS teammate and use Lullaby Bloom for setup or peel.');if(cls==='pala')this.log('You are the Paladin: Holy Shock crits empower fast Holy Lights; Sacrifice redirects ally damage to you.');this.log('Prism Hex lasts 7s but breaks on damage; set up your kill target before swapping.');this.log('Stormwarden builds Overload with Arc Spark; Flame sustains mana by landing spells and Counterflare.');this.log('v161 AI pass: combat bots have been restored to the proven v148 behaviour baseline, while tournament flow now builds the bracket first and lets you continue or restart cleanly.');}
 queueDispose(obj){if(!obj)return;this.disposeQueue.push(obj);this.scheduleDisposals();}
 disposeObject(obj){obj?.traverse?.(node=>{node.geometry?.dispose?.();if(node.material){const mats=Array.isArray(node.material)?node.material:[node.material];mats.forEach(material=>material?.dispose?.());}});}
 flushDisposals(limit=5){let processed=0;while(this.disposeQueue.length&&processed<limit){this.disposeObject(this.disposeQueue.shift());processed++;}}
 scheduleDisposals(){if(this.disposalHandle||!this.disposeQueue.length)return;const drain=deadline=>{this.disposalHandle=null;let processed=0;while(this.disposeQueue.length&&processed<4&&(!deadline||deadline.didTimeout||deadline.timeRemaining()>1)){this.disposeObject(this.disposeQueue.shift());processed++;}if(this.disposeQueue.length)this.scheduleDisposals();};if(typeof requestIdleCallback==='function'){this.disposalKind='idle';this.disposalHandle=requestIdleCallback(drain,{timeout:250});}else{this.disposalKind='timeout';this.disposalHandle=setTimeout(()=>drain(null),16);}}
 clear(){this.cancelGroundTarget();if(this.finishTimer){clearTimeout(this.finishTimer);this.finishTimer=null;}if(this.disposalHandle){if(this.disposalKind==='idle'&&typeof cancelIdleCallback==='function')cancelIdleCallback(this.disposalHandle);else clearTimeout(this.disposalHandle);this.disposalHandle=null;}this.finishPending=false;this.units.forEach(u=>{this.clearTotemMasteryVisuals?.(u);this.clearCombustionVisuals?.(u);u.destroy();});this.units=[];this.effects.forEach(e=>{this.scene.remove(e.obj);this.disposeQueue.push(e.obj);});this.effects=[];this.flushDisposals(Infinity);$('#worldLabels').innerHTML='';$('#floaters').innerHTML='';this.logs=[];this.encounterView=null;this.detailsSelection=null;$('#encounterDetails').classList.add('hidden');$('#detailsReport').classList.add('hidden');}
 spawn(name,cls,team,x,z,isPlayer=false){const u=new Character(this,{name,cls,team,x,z,isPlayer});this.units.push(u);if(isPlayer)this.player=u;else u.ai=new AIController(this,u);return u;}
 keydown(e){this.audio.ensure();if(this.groundTargeting&&e.code==='Escape'){e.preventDefault();this.cancelGroundTarget('Ground targeting cancelled');return;}if(!$('#armoury').classList.contains('hidden')){if(e.code==='Escape')this.closeArmoury();return;}if(!$('#encounterDetails').classList.contains('hidden')){if(e.code==='Escape')this.closeEncounterDetails();return;}if(!$('#classGuide').classList.contains('hidden')){if(e.code==='Escape')this.closeClassGuide();return;}if(!$('#achievements').classList.contains('hidden')){if(e.code==='Escape')this.closeAchievements();return;}if(e.code==='Backquote'){e.preventDefault();$('#debug').classList.toggle('hidden');this.updateDebug();return;}
  if($('#settings').classList.contains('hidden')===false){if(this.awaitFocusBind){if(['ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight'].includes(e.code))return;e.preventDefault();this.assignFocusBind(eventCombo(e));return;}if(this.awaitBind){if(['ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight'].includes(e.code))return;e.preventDefault();const heldMovement=['forward','backward','left','right'].includes(this.awaitBind);this.assignBind(heldMovement?e.code:eventCombo(e));return;}if(e.code==='Escape')this.closeSettings();return;}
  if(!$('#pauseMenu').classList.contains('hidden')){if(e.code==='Escape'){e.preventDefault();this.closePauseMenu();}return;}
  if(e.code==='Escape'&&(this.phase==='fight'||this.phase==='countdown')){e.preventDefault();if(this.target){this.target=null;this.message('Target cleared');}else this.openPauseMenu();return;}
  const combo=eventCombo(e);if(combo===binds.pause&&this.phase!=='menu'){e.preventDefault();this.openSettings(true);return;} if(this.phase!=='fight'||this.paused)return;
  if(this.tryFocusBind(combo)){e.preventDefault();return;}
  if(combo===binds.trinket){e.preventDefault();this.useTrinket();return;} if(combo===binds.mount){e.preventDefault();this.toggleMount();return;} if(combo===binds.jump){e.preventDefault();if(!e.repeat)this.jumpPlayer();return;}
  if([binds.forward,binds.backward,binds.left,binds.right].includes(e.code))e.preventDefault();this.keys[e.code]=true;if(combo===binds.enemy){e.preventDefault();this.cycleTarget('enemy');} if(combo===binds.ally){e.preventDefault();this.cycleTarget('ally');}
  const actionLayout=this.classAbilityDisplayOrder(this.player.cls);for(let slot=0;slot<14;slot++)if(actionLayout[slot]&&combo===binds['a'+(slot+1)]){e.preventDefault();if(e.repeat&&this.cancelsOnRepress(actionLayout[slot].i))break;this.playerCast(actionLayout[slot].i);break;}
  if(combo===binds.mobility){e.preventDefault();const i=this.player.cls==='flame'?3:this.player.cls==='shadow'?1:this.player.cls==='storm'?4:this.player.cls==='wind'?1:null;if(i!==null)this.playerCast(i);}
 }
 cycleTarget(team){const arr=this.units.filter(u=>u.alive&&(team==='enemy'?u.team!==this.player.team:u.team===this.player.team));if(!arr.length)return;let i=arr.indexOf(this.target);this.target=arr[(i+1)%arr.length];}
 pick(e){this.audio.ensure();if(this.phase!=='fight')return;const r=this.canvas.getBoundingClientRect();const px=e.clientX,py=e.clientY;this.mouse.x=((px-r.left)/r.width)*2-1;this.mouse.y=-((py-r.top)/r.height)*2+1;this.ray.setFromCamera(this.mouse,this.camera);
  const clickable=this.units.filter(u=>u.alive&&u.clickHitbox).map(u=>u.clickHitbox);
  const hits=this.ray.intersectObjects(clickable,false).map(h=>h.object.userData.unit).filter(Boolean);
  const rayTarget=hits.find(u=>u!==this.player)||hits[0];
  const candidates=this.units.filter(u=>u.alive&&u!==this.player).map(u=>{const p=this.toScreen(u);return {u,d:Math.hypot(p.x-px,p.y-py)};}).filter(x=>x.d<68).sort((a,b)=>a.d-b.d||((a.u.team!==this.player.team)?-1:1));
  const screenTarget=candidates[0]?.u;
  const chosen=screenTarget||rayTarget;
  if(chosen){this.target=chosen;this.message(`${chosen.info.badge} Target: ${chosen.name} — ${chosen.info.name}`);if(this.player&&['sage','pala'].includes(this.player.cls)&&chosen.team!==this.player.team)this.manualSupportAttack(this.player,chosen,true);}
 }
 isInCombat(u){return !!u&&u.combatUntil>this.time;}
 breakableControl(u){if(!u)return null;return u.effects.find(e=>['furyStun','cheapStun','stun','fear','poly','sleep','gouge','blind','windIncap','root'].includes(e.type)&&e.time>.18)||null;}
 abilityReady(u,names){const arr=AB[u?.cls]||[];const i=arr.findIndex(a=>names.includes(a.name)||names.includes(a.type));return i>=0&&u.cds?.[i]<=0?i:-1;}
 majorDefensiveActive(u){return !!(u&&['iceBlock','defensive','evasion','cloakShadows','touchKarma','warriorGuard','divineSteed','sacrifice','ironbark','painSuppression','discFade','shield'].some(x=>u.has?.(x)));}
 unitUnderMajorOffensive(u){
  if(!u||!u.alive)return false;
  if(u.has('vendetta')||u.has('smokeBomb'))return true;
  const enemies=this.units.filter(e=>e.alive&&e.team!==u.team&&!isUntargetableStealth(e,u));
  return enemies.some(e=>{
   if(e.has('combustion')&&dist(e,u)<=27&&this.arena.los(e,u))return true;
   if(e.has('stormkeeper')&&dist(e,u)<=27&&this.arena.los(e,u))return true;
   if(e.has('avatar')&&dist(e,u)<=6.2)return true;
   if(e.has('warbreakerReady')&&dist(e,u)<=5.2)return true;
   if(e.has('tigereye')&&dist(e,u)<=6.4)return true;
   return false;
  });
 }
 botCanSelfSaveSoon(u){if(!u||!u.alive)return false;if(this.majorDefensiveActive(u))return true;if(u.cls==='flame')return this.abilityReady(u,['Ice Block','iceBlock'])>=0;if(u.cls==='wind')return this.abilityReady(u,['Touch of Karma','karma'])>=0;if(u.cls==='warrior')return this.abilityReady(u,['Shield Wall','warriorGuard'])>=0;if(u.cls==='shadow')return this.abilityReady(u,['Evasion','Cloak of Shadows','Crimson Vial'])>=0;if(u.cls==='storm')return this.abilityReady(u,['Static Aegis','Grounding Aegis'])>=0;if(u.cls==='soul')return this.abilityReady(u,['Dark Pact'])>=0;if(u.cls==='disc')return this.abilityReady(u,['Pain Suppression','Power Shield','Ultimate Radiance','Fade'])>=0;return false;}
 unitUnderBurst(u){if(!u||!u.alive)return false;const hp=u.hp/u.maxHp;const enemies=this.units.filter(e=>e.alive&&e.team!==u.team&&!isUntargetableStealth(e,u));return hp<.62||this.unitUnderMajorOffensive(u)||u.has('smokeBomb')||enemies.some(e=>this.attacking?.(u,e)||dist(e,u)<5.5||e.cast?.target===u);}
 majorOffensiveActiveOnUnit(u){return !!(u&&(u.has('combustion')||u.has('stormkeeper')||u.has('tempestBolts')||u.has('instantBolt')||u.has('meteorLance')||u.has('volcanicEruptionReady')||u.has('avatar')||u.has('tigereyeBrew')||u.has('tigereye')||u.has('risingSunReady')||u.has('warbreakerReady')||u.has('empoweredSwing')||u.has('gushingWoundReady')||u.has('vendetta')||u.has('eviscerateReady')||u.has('venomEdge')||u.has('smokePower')));}
 teamOffensiveWindowFor(u){
  if(!u||!u.alive)return false;
  const allies=this.units.filter(a=>a.team===u.team&&a.alive),enemies=this.units.filter(e=>e.team!==u.team&&e.alive);
  const teamReasonablyAlive=allies.every(a=>a.hp/a.maxHp>.42&&!a.has('smokeBomb'));
  if(!teamReasonablyAlive)return false;
  const majorCommitted=allies.some(a=>this.majorOffensiveActiveOnUnit(a));
  const enemyHealerControlled=enemies.some(e=>['sage','pala','disc'].includes(e.cls)&&this.breakableControl(e));
  const vulnerable=enemies.some(e=>{
   const hp=e.hp/e.maxHp,defDown=!this.botCanSelfSaveSoon(e),trinketDown=e.trinketCd>0;
   return hp<.48||this.unitUnderMajorOffensive(e)||e.has('smokeBomb')||trinketDown&&defDown&&hp<.82||enemyHealerControlled&&hp<.72;
  });
  return vulnerable&&(majorCommitted||enemyHealerControlled||enemies.some(e=>e.hp/e.maxHp<.48));
 }
 tryBotControlledDefensive(u,cc){
  if(!u||!cc||!u.alive)return false;
  const hp=u.hp/u.maxHp,major=this.unitUnderMajorOffensive(u);
  if(u.cls==='flame'){
   const ice=this.abilityReady(u,['Ice Block','iceBlock']);
   const focused=this.unitUnderBurst(u)||['cheapStun','stun','furyStun'].includes(cc.type);
   if(ice>=0&&(u.has('smokeBomb')||hp<.50||(major&&focused&&hp<.78)))return this.tryAbility(u,ice,u,false)===true;
  }
  return false;
 }
 shouldBotTrinket(u,cc,d){
  if(!u||!cc||u.trinketCd>0||cc.time<.85)return false;
  const hp=u.hp/u.maxHp,isHealer=['sage','pala','disc'].includes(u.cls),isRoot=cc.type==='root',majorSelf=this.unitUnderMajorOffensive(u);
  const allies=this.units.filter(a=>a.team===u.team&&a.alive),enemies=this.units.filter(e=>e.team!==u.team&&e.alive);
  const others=allies.filter(a=>a!==u);
  const partner=others.slice().sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0]||null;
  const partnerHp=partner?partner.hp/partner.maxHp:1;
  const partnerDanger=partner&&(partnerHp<.62||this.unitUnderMajorOffensive(partner)||partner.has('smokeBomb')||this.unitUnderBurst(partner));
  const partnerSafeSave=partner&&(this.majorDefensiveActive(partner)||this.botCanSelfSaveSoon(partner));
  const alliedHealer=allies.find(a=>['sage','pala','disc'].includes(a.cls));
  const healerControlled=alliedHealer&&this.breakableControl(alliedHealer);
  const enemyHealerCC=enemies.some(e=>['sage','pala','disc'].includes(e.cls)&&this.breakableControl(e));
  const enemyLow=enemies.some(e=>e.hp/e.maxHp<.38);
  const offensiveWindow=this.teamOffensiveWindowFor(u);
  const teamStable=allies.every(a=>a.hp/a.maxHp>.64&&!this.unitUnderMajorOffensive(a)&&!a.has('smokeBomb'));
  const longLock=['furyStun','cheapStun','stun','fear','poly','sleep','blind','windIncap'].includes(cc.type);

  // Hard defensive cases still take priority.
  if(majorSelf&&longLock&&hp<.72&&!this.majorDefensiveActive(u))return true;
  if(hp<.34&&longLock)return true;
  if(isRoot)return hp<.45||(enemyLow&&['shadow','wind','warrior'].includes(u.cls)&&cc.time>1.0);

  // Offensive trinket: only when the team is stable and a real kill/setup window exists.
  // This allows bots to trinket to finish a coordinated push, but not randomly because a cooldown was pressed.
  if(offensiveWindow&&longLock&&cc.time>1.05){
   const comebackOk=!teamStable&&hp>.58&&partnerHp>.42&&enemies.some(e=>e.hp/e.maxHp<.52||this.unitUnderMajorOffensive(e)||e.has('smokeBomb'));
   if(teamStable||comebackOk){
    if(isHealer){
     if(!partnerDanger||partnerSafeSave||partnerHp>.70)return true;
    }else{
     if(!healerControlled||hp>.62||comebackOk)return true;
    }
   }
  }

  if(isHealer){
   if(partnerDanger){
    if(partnerSafeSave&&partnerHp>.34&&!partner.has('smokeBomb')&&!this.unitUnderMajorOffensive(partner))return false;
    return cc.time>.70;
   }
   if(enemyLow&&enemyHealerCC&&allies.every(a=>a.hp/a.maxHp>.72))return cc.time>1.35;
   return false;
  }
  if(healerControlled&&partnerDanger&&!this.botCanSelfSaveSoon(partner))return cc.time>.85;
  if(partner&&['sage','pala','disc'].includes(partner.cls)&&this.breakableControl(partner)&&hp<.62)return cc.time>1.0;
  if(enemyLow&&enemyHealerCC&&hp>.55)return cc.time>.92;
  return longLock&&hp<.58&&cc.time>1.0;
 }
 botTrinketDelay(u,cc,d){
  const hp=u.hp/u.maxHp,allies=this.units.filter(a=>a.team===u.team&&a.alive),others=allies.filter(a=>a!==u);
  const partner=others.slice().sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];
  const partnerDanger=partner&&(partner.hp/partner.maxHp<.52||partner.has('smokeBomb')||this.unitUnderMajorOffensive(partner)||this.unitUnderBurst(partner));
  if(hp<.34||this.unitUnderMajorOffensive(u)||partnerDanger)return .04+Math.random()*.08;
  if(this.teamOffensiveWindowFor(u))return .08+Math.random()*.12;
  const enemies=this.units.filter(e=>e.team!==u.team&&e.alive);
  if(enemies.some(e=>e.hp/e.maxHp<.38)&&enemies.some(e=>['sage','pala','disc'].includes(e.cls)&&this.breakableControl(e)))return .10+Math.random()*.14;
  return .22+Math.random()*.20;
 }
 tryBotEmergencyDefensive(u){
  if(!u||!u.alive||this.phase!=='fight')return false;
  const hp=u.hp/u.maxHp,major=this.unitUnderMajorOffensive(u);
  if(!major&&hp>.38)return false;
  if(u.cls==='flame'){const i=this.abilityReady(u,['Ice Block','iceBlock']);if(i>=0&&(hp<.48||major&&hp<.70||u.has('smokeBomb')))return this.tryAbility(u,i,u,false)===true;}
  if(u.cls==='wind'){const i=this.abilityReady(u,['Touch of Karma','karma']);if(i>=0&&(hp<.52||major&&hp<.70))return this.tryAbility(u,i,u,false)===true;}
  if(u.cls==='warrior'){const i=this.abilityReady(u,['Shield Wall','warriorGuard']);if(i>=0&&(hp<.50||major&&hp<.68))return this.tryAbility(u,i,u,false)===true;}
  if(u.cls==='shadow'){const i=this.abilityReady(u,['Evasion','Cloak of Shadows','Crimson Vial']);if(i>=0&&hp<.48)return this.tryAbility(u,i,u,false)===true;}
  if(u.cls==='storm'){const i=this.abilityReady(u,['Static Aegis','Grounding Aegis']);if(i>=0&&(hp<.48||major&&hp<.66))return this.tryAbility(u,i,u,false)===true;}
  if(u.cls==='disc'){const fade=this.abilityReady(u,['Fade','discFade']);if(fade>=0&&(hp<.48||major&&hp<.68))return this.tryAbility(u,fade,u,false)===true;}if(u.cls==='soul'){const wall=this.abilityReady(u,['Undying Resolve','undyingResolve']);if(wall>=0&&(hp<.62||major&&hp<.82||u.has('smokeBomb')||this.breakableControl(u)&&hp<.72))return this.tryAbility(u,wall,u,false)===true;const i=this.abilityReady(u,['Dark Pact']);if(i>=0&&(hp<.48||major&&hp<.66))return this.tryAbility(u,i,u,false)===true;}
  return false;
 }

 enterCombat(...units){units.filter(Boolean).forEach(u=>{u.combatUntil=Math.max(u.combatUntil||0,this.time+7);if(u.cast&&u.cast.special==='mount'){u.cast=null;if(u===this.player)this.message('Mount interrupted — you entered combat');}if(u.mounted)this.dismount(u,true);});}
 dismount(u,quiet=false){if(!u||!u.mounted)return;u.mounted=false;if(u===this.player&&!quiet)this.message('Dismounted');this.vfxRing(u,0x74e9f7,1.35);}
 tryMount(u,announce=false){if(!u||!u.alive||this.phase!=='fight')return false;if(u.mounted)return true;if(this.isInCombat(u)){if(announce)this.message('Cannot mount while in combat');return false;}if(u.cast){if(announce)this.message('Already casting');return false;}if(u.has('furyStun')||u.has('cheapStun')||u.has('stun')||u.has('poly')||u.has('sleep')||u.has('blind')||u.has('windIncap')||u.has('root')){if(announce)this.message('Cannot mount while controlled');return false;}const mount=mountDefinition(u===this.player?progression.activeMount:'skyhoof');u.cast={a:{name:`Summon ${mount.name}`,icon:mount.icon,type:'mount',school:'nature',range:0},index:-1,target:u,total:1.5,left:1.5,school:'nature',special:'mount'};this.audio.play('mountSummon');if(announce)this.message(`Summoning ${mount.name}…`);return true;}
 toggleMount(){const u=this.player;if(!u||!u.alive||this.phase!=='fight')return;if(u.mounted){this.dismount(u);return;}this.tryMount(u,true);}
 useTrinket(u=this.player,fromAI=false){if(!u||!u.alive||this.phase!=='fight')return false;if(u.trinketCd>0){if(!fromAI&&u===this.player)this.message(`Medallion ready in ${u.trinketCd.toFixed(1)}s`);return false;}const remove=e=>['furyStun','cheapStun','stun','fear','poly','sleep','gouge','blind','windIncap','root','slow','silence'].includes(e.type)||e.type.startsWith('lock_');const removed=u.effects.filter(remove);if(!removed.length&&fromAI)return false;u.trinketCd=60;this.float(u,'MEDALLION!', 'info');this.vfxGlyph(u,0xffd36b,.8);this.vfxNova(u,0xffe6a0,1.6,12);this.audio.play('proc');if(removed.length){u.effects=u.effects.filter(e=>!remove(e));u.cast=null;if(u===this.player)this.message("Gladiator's Medallion used — CC removed");else this.log(`${u.name} used Gladiator's Medallion.`);}else if(u===this.player){this.float(u,'MISSED!', 'error');this.message("Gladiator's Medallion used — no CC removed");}return true;}
  focusEnemy(slot){return this.units.filter(u=>u.team==='enemy')[slot]||null;}
 focusAlly(slot){return this.units.filter(u=>u.team===this.player?.team)[slot]||null;}
 focusTargetMode(a){return ['heal','hot','shield','spiritBlossom','ironbark','bigHeal','cleanse','holyLight','sacrifice','intercept','bestowFaith','discShield','discMend','painSuppression'].includes(a?.type)?'ally':'enemy';}
 castFocusAbility(slot,abilityIndex){if(!this.player||!this.player.alive)return false;const a=AB[this.player.cls][abilityIndex];if(!a)return true;const mode=this.focusTargetMode(a),target=mode==='ally'?this.focusAlly(slot):this.focusEnemy(slot),label=mode==='ally'?'Ally':'Enemy';if(!target||!target.alive){this.message(`${label} ${slot+1} is unavailable`);return true;}this.castFor(this.player,abilityIndex,target);return true;}
 tryFocusBind(combo){if(!this.player)return false;const all=ensureFocusClass(this.player.cls);for(const [ability,rows] of Object.entries(all)){const macro=rows.find(m=>m.key&&m.key===combo);if(macro)return this.castFocusAbility(macro.enemySlot,+ability);}return false;}
 createGroundTargetReticle(a){
  const group=new THREE.Group(),radius=a.type==='meteor'?5.2:(a.radius||4.5),colour=a.type==='meteor'?0xff6a2b:(a.type==='summonInfernal'?0xff6b24:0x9d48ff);
  const mat=(opacity=.72)=>new THREE.MeshBasicMaterial({color:colour,transparent:true,opacity,side:THREE.DoubleSide,depthWrite:false,depthTest:false,blending:THREE.AdditiveBlending});
  const outer=new THREE.Mesh(new THREE.RingGeometry(radius*.88,radius,64),mat(.78)),inner=new THREE.Mesh(new THREE.RingGeometry(radius*.42,radius*.48,48),mat(.46));outer.rotation.x=inner.rotation.x=-Math.PI/2;outer.position.y=inner.position.y=.08;group.add(outer,inner);
  const trianglePoints=[];for(let i=0;i<3;i++){const ang=-Math.PI/2+i*Math.PI*2/3,ang2=-Math.PI/2+(i+1)%3*Math.PI*2/3;trianglePoints.push(Math.cos(ang)*radius*.62,.095,Math.sin(ang)*radius*.62,Math.cos(ang2)*radius*.62,.095,Math.sin(ang2)*radius*.62);}const triangle=new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(trianglePoints,3)),new THREE.LineBasicMaterial({color:colour,transparent:true,opacity:.72,depthTest:false,depthWrite:false,blending:THREE.AdditiveBlending}));group.add(triangle);
  for(let i=0;i<16;i++){const tick=new THREE.Mesh(new THREE.BoxGeometry(radius*.055,.025,radius*(i%4===0?.22:.13)),mat(i%4===0?.92:.58)),ang=i/16*Math.PI*2;tick.position.set(Math.cos(ang)*radius*.77,.10,Math.sin(ang)*radius*.77);tick.rotation.y=-ang;group.add(tick);}
  const fill=new THREE.Mesh(new THREE.CircleGeometry(radius*.86,48),mat(.10));fill.rotation.x=-Math.PI/2;fill.position.y=.045;group.add(fill);group.renderOrder=120;this.scene.add(group);return {group,outer,inner,triangle,fill,colour,radius};
 }
 groundPointFromEvent(e){const r=this.canvas.getBoundingClientRect();this.mouse.x=((e.clientX-r.left)/r.width)*2-1;this.mouse.y=-((e.clientY-r.top)/r.height)*2+1;this.ray.setFromCamera(this.mouse,this.camera);const point=new THREE.Vector3();return this.ray.ray.intersectPlane(this.groundPlane,point)?point:null;}
 beginGroundTarget(index,a){
  if(!this.player||this.phase!=='fight')return;
  if(this.groundTargeting){if(this.groundTargeting.index===index){this.cancelGroundTarget('Ground targeting cancelled');return;}this.cancelGroundTarget();}
  if(this.player.cds[index]>0){this.message(`${a.name} is not ready`);return;}if(this.player.resource<a.cost){this.message('Not enough resource');return;}if(this.player.cast){this.message('Finish your current cast first');return;}if(this.player.gcd>0){this.message('Another ability is still recovering');return;}
  const fx=this.createGroundTargetReticle(a),point=this.target&&this.target.team!==this.player.team?new THREE.Vector3(this.target.x,0,this.target.z):new THREE.Vector3(this.player.x+Math.sin(this.cameraRig.facingYaw)*8,0,this.player.z+Math.cos(this.cameraRig.facingYaw)*8);
  this.groundTargeting={index,a,fx,point,valid:true};fx.group.position.set(point.x,0,point.z);this.updateGroundTargetValidity();this.canvas.classList.add('ground-targeting');this.message(`${a.name}: move the circle within ${a.range}m, then left-click to place it. Right-click or Escape cancels.`);
 }
 updateGroundTarget(e){if(!this.groundTargeting)return;const point=e?this.groundPointFromEvent(e):null;if(point)this.groundTargeting.point.set(point.x,0,point.z);this.groundTargeting.fx.group.position.set(this.groundTargeting.point.x,0,this.groundTargeting.point.z);this.groundTargeting.fx.group.rotation.y+=.015;this.updateGroundTargetValidity();}
 updateGroundTargetValidity(){const g=this.groundTargeting;if(!g||!this.player)return;g.distance=dist(this.player,g.point);g.inRange=g.distance<=g.a.range;g.hasLos=this.arena.los(this.player,g.point);g.valid=g.inRange&&g.hasLos;const colour=g.valid?g.fx.colour:0xff2448;g.fx.group.traverse(o=>{if(o.material?.color)o.material.color.setHex(colour);});}
 confirmGroundTarget(){const g=this.groundTargeting;if(!g)return;if(!g.valid){this.message(!g.hasLos?`${g.a.name}: a pillar blocks that spot — move the circle or step around it`:`${g.a.name} reaches ${g.a.range}m and that spot is ${Math.round(g.distance)}m away — move closer or place it nearer`);return;}const abilityName=g.a.name,point={x:g.point.x,z:g.point.z,alive:true,team:this.player.team==='ally'?'enemy':'ally',groundTarget:true,has:()=>null};const index=g.index;this.cancelGroundTarget();this.message(abilityName==='Meteor'?'Meteor incoming!':abilityName==='Summon Infernal'?'Infernal incoming!':'Shadowfury erupts!');this.castFor(this.player,index,point);}
 cancelGroundTarget(message=''){const g=this.groundTargeting;if(!g)return;this.groundTargeting=null;this.canvas?.classList.remove('ground-targeting');if(g.fx?.group){this.scene.remove(g.fx.group);this.queueDispose(g.fx.group);}if(message)this.message(message);}
  cancelsOnRepress(i){const a=AB[this.player?.cls]?.[i];if(!a)return false;/* A second press of these deliberately cancels, so key auto-repeat must not reach them. */return ['fistsChannel','bladestorm','iceBlock','soulDrain'].includes(a.type);}
  playerCast(i){const a=AB[this.player?.cls]?.[i];if(this.player?.cast?.soulDrain&&a?.type==='soulDrain'){if(this.netGuest&&this.netSession)this.netSession.sendCast(i,this.target);else{this.player.cast=null;this.float(this.player,'ESSENCE SIPHON CANCELLED','info');this.log(`${this.player.name} stops channeling Essence Siphon.`);}return;}if(a&&['meteor','groundStun','summonInfernal'].includes(a.type)){this.beginGroundTarget(i,a);return;}this.castFor(this.player,i,this.target);}
  castFor(u,i,target){if(this.netGuest&&u===this.player){if(this.netSession)this.netSession.sendCast(i,target);return;}let a=AB[u.cls][i];if(!a)return;if(a.type==='discPenance'){if(!target||!target.alive)target=u;}else if(['buff','dash','defensive','shieldSelf','push','healerEscape','natureSwiftness','undyingResolve','monkDefensive','fistsChannel','ghanir','ultimateRadiance','discFade','discFear','archangel','darkArchangel','angelicBody','flameNova','paladinAoE','paladinGuard','paladinSteed','iceBlock','reflect','shout','warriorGuard','sharpenBlade','avatar'].includes(a.type))target=u;else if(a.type==='holyShock'){if(!target||!target.alive)target=u;}else if(['heal','hot','shield','spiritBlossom','ironbark','bigHeal','cleanse','freedom','guardianAngel','holyLight','sacrifice','intercept','bestowFaith','discShield','discMend','painSuppression'].includes(a.type)){if(!target||target.team!==u.team||!target.alive)target=a.type==='intercept'?this.units.filter(x=>x.team===u.team&&x!==u&&x.alive).sort((x,y)=>x.hp/x.maxHp-y.hp/y.maxHp)[0]||u:u;}else{if(!target||target.team===u.team||!target.alive)target=this.closestEnemy(u);}this.tryAbility(u,i,target,u===this.player);}
 closestEnemy(u){return this.units.filter(x=>x.team!==u.team&&x.alive).sort((a,b)=>dist(u,a)-dist(u,b))[0];}
 
 applyTalentAbilityMods(c,a,index){
  if(!c||!c.cls)return a;
  let out={...a};
  const r=id=>talentRank(c.cls,id);
  if(c.cls==='flame'){
   if(out.name==='Blazing Step')out.cd=Math.max(.5,out.cd-r('swiftstep'));
   if(out.name==='Prism Hex')out.cast=Math.max(.6,out.cast-r('hexmastery')*.10);
  }
  if(c.cls==='warrior'&&out.name==='Shield Wall')out.cd=Math.max(20,out.cd-r('ironwall')*3);
  if(c.cls==='storm'&&out.name==='Wind Shear')out.cd=Math.max(4,out.cd-r('windfocus'));
  if(c.cls==='disc'){
   if(out.name==='Pain Suppression')out.cd=Math.max(25,out.cd-r('disc_pain')*3);
   if(out.name==='Power Shield')out.value=Math.round(out.value*(1+r('disc_shielding')*.06));
   if(out.name==='Shadow Mend')out.value=Math.round(out.value*(1+r('disc_darklight')*.04));
  }
  if(c.cls==='pala'){
   if(out.name==='Holy Light')out.cast=Math.max(.85,out.cast-r('fastlight')*.08);
   if(out.name==='Divine Steed')out.cd=Math.max(10,out.cd-r('steadfast')*2);
   if(out.name==='Cleanse')out.cd=Math.max(6,out.cd-r('cleanhands')*.5);
  }
  if(c.cls==='sage'){
   if(out.cast&&['Verdant Mend','Healing Wave','Lifebloom'].some(n=>out.name.includes(n)))out.cast=Math.max(.8,out.cast-r('quickmend')*.08);
   if(out.name==='Purifying Light')out.cd=Math.max(6,out.cd-r('cleanhands')*.5);
   if(['Fae Retreat','Lullaby Bloom','Nature’s Grasp'].includes(out.name))out.cd=Math.max(8,out.cd-r('sage_root_warden')*2);
   if(['Fae Retreat','Ironbark'].includes(out.name))out.cd=Math.max(12,out.cd-r('barkskin')*2);
  }
  if(c.cls==='shadow'){
   if(out.name==='Umbral Pounce')out.cd=Math.max(6,out.cd-r('pounceflow'));
   if(out.name==='Smoke Bomb')out.value=(out.value||0)+r('smoketactics')*.25;
   if(['Smoke Veil','Evasion','Cloak of Shadows'].includes(out.name))out.effectDurationBonus=r('shadow_veil_training')*.25;
  }
  if(c.cls==='soul'&&out.name==='Grasping Gloom')out.range+=r('gloomreach');
  if(c.cls==='wind'){
   if(out.name==='Cloudstep Kick')out.cd=Math.max(6,out.cd-r('longdash')-r('tigerdash')-r('wind_nimble_brew'));
   if(out.name==="Tiger's Lust")out.cd=Math.max(6,out.cd-r('tigerdash')-r('wind_nimble_brew'));
   if(['Disabling Reach','Strike of the Windlord'].includes(out.name))out.cd=Math.max(6,out.cd-r('wind_nimble_brew'));
  }
  if(c.has&&c.has('combustion')&&out.cast)out.cast=Math.max(.25,out.cast*.85);if(c.has&&c.has('windlordReady')&&out.name==='Cloudstep Kick'){out.value=Math.round((out.value||0)*1.15);out.tip=(out.tip||'')+' Strike of the Windlord empowered: +15% damage.';}
  return out;
 }

validate(caster,a,target,show,opts={}){if(!caster.alive)return false;if(caster.has('iceBlock')&&a.type!=='iceBlock')return this.fail(caster,'Immune inside Ice Block — cancel it first',show);if(!caster.has('bladestorm')&&a.type!=='iceBlock'&&(caster.has('furyStun')||caster.has('cheapStun')||caster.has('stun')||caster.has('fear')||caster.has('poly')||caster.has('sleep')||caster.has('gouge')||caster.has('blind')||caster.has('windIncap')))return this.fail(caster,'Crowd controlled',show);if((caster.has('silence')&&a.school!=='physical')||caster.has('lock_'+a.school))return this.fail(caster,'Spell locked',show);if(caster.cast&&!opts.ignoreCast)return this.fail(caster,'Already casting',show);if(caster.gcd>0&&!opts.ignoreGcd)return false;const cdIndex=Number.isInteger(opts.index)?opts.index:AB[caster.cls].indexOf(a);if(!opts.ignoreCd&&cdIndex>=0&&caster.cds[cdIndex]>0)return this.fail(caster,'Ability not ready',show);if(caster.resource<a.cost)return this.fail(caster,'Not enough resource',show);const self=['buff','dash','defensive','shieldSelf','push','healerEscape','natureSwiftness','undyingResolve','monkDefensive','fistsChannel','whirlingDragonPunch','ghanir','ultimateRadiance','discFade','discFear','archangel','darkArchangel','angelicBody','flameNova','paladinAoE','paladinGuard','paladinSteed','iceBlock','reflect','shout','warriorGuard','sharpenBlade','avatar','combustion','flameShield','evasion','cloak','totemMastery','stormkeeper','tigereyeBrew','karma','bladestorm','tigersLust'].includes(a.type);const friendly=['heal','hot','shield','spiritBlossom','ironbark','bigHeal','cleanse','freedom','guardianAngel','holyLight','sacrifice','intercept','bestowFaith','discShield','discMend','painSuppression'].includes(a.type);if(!self&&(!target||!target.alive))return this.fail(caster,'No valid target',show);if(!self&&target&&isUntargetableStealth(target,caster))return this.fail(caster,'Target is stealthed',show);if(friendly&&target&&target.team!==caster.team)return this.fail(caster,'Target an ally',show);if(a.type==='sacrifice'&&target===caster)return this.fail(caster,'Choose an ally for Sacrifice',show);if(a.type==='intercept'&&target===caster)return this.fail(caster,'Choose an ally for Intercept',show);if(!self&&dist(caster,target)>a.range)return this.fail(caster,'Out of range',show); if(!self&&!this.arena.los(caster,target))return this.fail(caster,'Line of sight blocked',show);return true;}
 fail(c,msg,show){if(show&&c===this.player)this.message(msg);return false;}
 tryAbility(caster,index,target,show=false){let a=AB[caster.cls][index];if(a?.type==='whirlingDragonPunch'){const fistsIndex=(AB[caster.cls]||[]).findIndex(spell=>spell.type==='fistsChannel');if(fistsIndex<0||caster.cds[fistsIndex]<=0)return this.fail(caster,'Whirling Dragon Punch requires Fists of Fury to be on cooldown',show);}const natureSwiftChoice=caster.cls==='sage'&&!!caster.has('natureSwiftness')&&['Renewal Tide','Lullaby Bloom'].includes(a.name);if(natureSwiftChoice&&a.name==='Lullaby Bloom')a={...a,cast:0,natureSwiftChoice:true,tip:'Nature Swiftness: instant Lullaby Bloom.'};else if(natureSwiftChoice)a={...a,natureSwiftChoice:true};if(caster.cast?.a?.type==='fistsChannel'&&a.type==='fistsChannel'){caster.cast=null;if(caster.fistsFx)caster.fistsFx.dead=true;caster.fistsFx=null;this.float(caster,'FISTS OF FURY CANCELLED','info');return true;}if(caster.has&&caster.has('bladestorm')){if(a.type==='bladestorm'){caster.effects=caster.effects.filter(e=>e.type!=='bladestorm');caster.cast=null;if(caster.bladestormFx)caster.bladestormFx.dead=true;caster.bladestormFx=null;this.float(caster,'BLADESTORM CANCELLED','info');return true;}if(caster===this.player)this.message('Only Bladestorm can be pressed during Bladestorm');return false;}if(caster.has&&caster.has('iceBlock')&&a.type!=='iceBlock'){if(caster===this.player)this.message('Cannot cast while inside Ice Block');return false;}if(a.type==='iceBlock'&&caster.has('iceBlock')){caster.effects=caster.effects.filter(e=>e.type!=='iceBlock');this.float(caster,'ICE BLOCK CANCELLED','info');this.vfxBurst(caster,0xbfefff,.7);return true;}if(a.type==='iceBlock'&&caster.cast)caster.cast=null;const cloudstepDash=caster.cls==='wind'&&index===1&&caster.cds[index]<=0&&!caster.has('cloudstepDashCd');if(cloudstepDash)a={...a,range:17,value:Math.round(a.value*1.20),dashReady:true,tip:'Cloudstep Dash ready: leap up to 17m and deal 20% increased damage.'};const gushingProc=caster.cls==='warrior'&&index===2&&!!caster.has('gushingWoundReady');if(gushingProc)a={...a,name:'Gushing Wound',icon:'🩸',type:'gushingWound',cd:6,cost:15,value:141,tip:'Rip open the active Rend for 141 immediate damage and accelerate its bleeding ticks.'};const furyProc=false;/* v182: Fists of Fury is standalone, no Cyclone proc lock */if(furyProc)a={name:'Fists of Fury',icon:'🥊',type:'fistsChannel',school:'wind',range:5.0,cast:2.5,cd:0,cost:0,value:68,tip:'Channel for 2.5 sec, dealing 68 damage per wave. No longer stuns. Enemies caught in the barrage are slowed by 60% while taking repeated hits.'};const risingSunProc=a.name==='Zephyr Palm'&&!!caster.has('risingSunReady');if(risingSunProc)a={...a,name:'Rising Sun Kick',icon:'🌅',range:3.5,cost:12,value:271,risingSunProc:true,tip:'Strike of the Windlord proc: deliver a powerful golden Rising Sun Kick for 271 damage after the additional 20% buff.'};const volcanicReady=a.type==='volcanicEruption'&&!!caster.has('volcanicEruptionReady');if(a.type==='volcanicEruption'&&!volcanicReady)return this.fail(caster,'Skybreaker Pulse must ready Volcanic Eruption first',show);const meteorProc=a.name==='Ember Lance'&&!!caster.has('meteorLance');if(meteorProc)a={...a,cd:.40,tip:'Meteor Lance active: rapidly fire one off-global empowered +15% Ember Lance charge.'};if(target&&target.team!==caster.team&&target.has&&target.has('iceBlock')){if(caster===this.player)this.message('Target is immune');return false;}const instantProc=a.name==='Cinder Bolt'&&!!caster.has('instantBolt');const stormkeeperProc=caster.cls==='storm'&&index===0&&!!caster.has('stormkeeper');const tempestProc=caster.cls==='storm'&&index===0&&!!caster.has('tempestBolts')&&!stormkeeperProc;if(stormkeeperProc){a={...a,name:'Arc Spark',cast:0,cd:.25,cost:0,value:Math.round((a.value||124)*1.10),stormkeeperSpark:true,tip:'Stormkeeper: free instant Arc Spark with +10% damage. Consumes one Stormkeeper charge.'};}else if(tempestProc){a={...a,name:'Tempest Bolt',cast:0,cd:a.cd,value:173,tip:'Empowered rapid lightning proc dealing 173 damage. Storm Surge grants two bolts, fired every 0.25 sec.'};}const infusedHoly=a.name==='Holy Light'&&!!caster.has('infusion');if(infusedHoly)a={...a,cast:.75,infused:true,tip:'Infusion of Light active: cast Holy Light 50% faster.'};a=this.applyTalentAbilityMods(caster,a,index);if(a.type==='stormkeeper'||a.type==='avatar'||a.type==='fistsChannel'||a.type==='whirlingDragonPunch'||a.type==='ghanir'||a.type==='avengingWings'){target=caster;}/* SELF_TARGET_FORCE */if(caster.has&&caster.has('combustion')&&a.cast){a={...a,cast:a.cast*.85,combustionCastSpeedApplied:true};}const interruptAbility=['interrupt','interruptProc','windInterrupt','shadowInterrupt'].includes(a.type);const shadowOffGcd=caster.cls==='shadow'&&(a.type==='leap'||a.type==='singleStun'||a.name==='Garrote'||a.type==='vendetta'||a.type==='shiv');const novaOffGcd=caster.cls==='flame'&&a.type==='flameNova';const skybreakerOffGcd=caster.cls==='storm'&&a.name==='Skybreaker Pulse';const stormTalentOffGcd=caster.cls==='storm'&&a.type==='volcanicEruption';const cycloneOffGcd=caster.cls==='wind'&&['touchOfDeath','whirlingDragonPunch'].includes(a.type);const paladinOffGcd=caster.cls==='pala'&&['paladinSteed','avengingWings'].includes(a.type);const disciplineOffGcd=caster.cls==='disc'&&['painSuppression','archangel','darkArchangel','angelicBody'].includes(a.type);const sageOffGcd=caster.cls==='sage'&&a.type==='natureSwiftness';const soulOffGcd=caster.cls==='soul'&&a.name==='Grasping Gloom';const iceBlockOffGcd=a.type==='iceBlock';const flameTalentOffGcd=caster.cls==='flame'&&['Combustion','Living Bomb','Ice Nova','Frostfire Nova'].includes(a.name);const hexStep=caster.cls==='flame'&&a.name==='Blazing Step'&&['Prism Hex','Cinder Bolt'].includes(caster.cast?.a?.name);const castWhileCasting=(caster.cls==='flame'&&a.name==='Counterflare')||(caster.cls==='storm'&&a.name==='Wind Shear')||hexStep||flameTalentOffGcd;const offGcd=interruptAbility||shadowOffGcd||tempestProc||stormkeeperProc||meteorProc||novaOffGcd||flameTalentOffGcd||skybreakerOffGcd||stormTalentOffGcd||cycloneOffGcd||paladinOffGcd||disciplineOffGcd||sageOffGcd||soulOffGcd||iceBlockOffGcd||hexStep||(caster.cls==='wind'&&a.type==='tigereyeBrew')||(caster.cls==='warrior'&&(a.type==='pummel'||a.type==='reflect'||a.type==='warriorGuard'||a.type==='avatar'));if(tempestProc&&caster.tempestLock>0)return this.fail(caster,'Tempest Bolt recharging',show);if(!this.validate(caster,a,target,show,{ignoreGcd:instantProc||offGcd,ignoreCast:castWhileCasting,ignoreCd:natureSwiftChoice,index}))return false;const commitOnComplete=(a.cast>0)&&(a.type==='poly'||a.type==='sleep'||a.type==='fear'||a.type==='stormkeeper');const hostile=target&&target.team!==caster.team&&!['heal','hot','shield','spiritBlossom','ironbark','bigHeal','cleanse','holyLight','sacrifice','bestowFaith','discShield','discMend','painSuppression','paladinAoE','paladinGuard','paladinSteed','avengingWings','ghanir','iceBlock'].includes(a.type);if(hostile)this.enterCombat(caster,target);else if(target&&target.team===caster.team&&this.isInCombat(target))this.enterCombat(caster,target);if(caster.mounted)this.dismount(caster,true);if(infusedHoly){caster.effects=caster.effects.filter(e=>e.type!=='infusion');this.float(caster,'INFUSION · FAST HOLY LIGHT','info');this.vfxGlyph(caster,COLORS.holy,.72);}caster.resource-=a.cost;if(infusedHoly)this.gainMana(caster,6);if(!instantProc&&!offGcd)caster.gcd=caster.cls==='soul'?.5:BALANCE.gcd;else if(stormkeeperProc)caster.gcd=.25;if(!commitOnComplete&&!furyProc)caster.cds[index]=a.cd;if(natureSwiftChoice){caster.effects=caster.effects.filter(e=>e.type!=='natureSwiftness');this.float(caster,a.name==='Lullaby Bloom'?'INSTANT LULLABY BLOOM':'SWIFT RENEWAL TIDE','heal');this.vfxGlyph(caster,COLORS.heal,.82);}if(risingSunProc)caster.effects=caster.effects.filter(e=>e.type!=='risingSunReady');if(furyProc){caster.effects=caster.effects.filter(e=>e.type!=='furyReady');caster.cds[index]=12;caster.cast={a,index,target:caster,total:2.5,left:2.5,school:'wind',channel:true,uninterruptible:true,tick:.02,interval:.4,radius:5.0,ticks:0,furyCaught:new Set()};this.animateAction(caster,a);this.audio.play('wind');this.float(caster,'FISTS OF FURY!','info');this.vfxFistsChannel(caster,2.5);this.log(`${caster.name} channels Fists of Fury — nearby enemies are caught in the barrage.`);return true;}if(a.type==='bladestorm'){caster.cds[index]=a.cd;caster.effects=caster.effects.filter(e=>!['slow','root','stun','cheapStun','furyStun'].includes(e.type));caster.effect('bladestorm',4,{immune:true});caster.cast={a,index,target:caster,total:4,left:4,school:'physical',channel:true,uninterruptible:true,moveCast:true,moveSpeedMult:.78,tick:.02,interval:.55,radius:5.2,ticks:0,bladestorm:true};this.animateAction(caster,a);this.audio.play('warriorBlade');this.vfxBladestormChannel(caster,4);this.float(caster,'BLADESTORM · PRESS AGAIN TO CANCEL','info');this.log(`${caster.name} channels Bladestorm and cannot use other abilities.`);return true;}if(a.type==='fistsChannel'){caster.cds[index]=a.cd;caster.cast={a,index,target:caster,total:a.cast||2.5,left:a.cast||2.5,school:'wind',channel:true,uninterruptible:true,moveCast:true,moveSpeedMult:.30,tick:.02,interval:.4,radius:a.range||5.0,ticks:0,furyCaught:new Set()};this.animateAction(caster,a);this.audio.play('wind');this.float(caster,'FISTS OF FURY · MOVING CHANNEL','info');this.vfxFistsChannel(caster,a.cast||2.5);this.log(`${caster.name} channels Fists of Fury while moving at reduced speed.`);return true;}if(a.type==='discPenance'){const radiant=!!caster.has('radiantPenanceProc');if(radiant)caster.effects=caster.effects.filter(e=>e.type!=='radiantPenanceProc');const total=radiant?1.05:1.5,interval=radiant?.35:.5;caster.cds[index]=a.cd;caster.cast={a,index,target,total,left:total,school:'holy',channel:true,discPenance:true,radiantPenance:radiant,moveCast:true,moveSpeedMult:1,tick:.02,interval,ticks:0};this.animateAction(caster,a);this.audio.play('holy');this.float(caster,radiant?'RADIANT PENANCE · 30% FASTER':'PENANCE · 3 BOLTS','info');this.vfxGlyph(caster,radiant?0xffffff:COLORS.discipline,radiant?1.18:.9);this.log(`${caster.name} channels ${radiant?'Radiant Penance':'Penance'}.`);return true;}if(a.type==='soulDrain'){caster.cds[index]=a.cd;caster.cast={a,index,target,total:2.5,left:2.5,school:'shadow',channel:true,soulDrain:true,tick:.04,interval:.5};this.animateAction(caster,a);this.audio.play('shadow');this.float(caster,'ESSENCE SIPHON','info');this.vfxSiphonChannel(caster,target,2.5);this.log(`${caster.name} channels Essence Siphon — affliction stacks amplify every drain tick.`);return true;}if(tempestProc){caster.tempestLock=.25;let bolts=caster.has('tempestBolts');bolts.stacks=(bolts.stacks||2)-1;if(bolts.stacks<=0)caster.effects=caster.effects.filter(e=>e!==bolts);else bolts.time=10;this.float(caster,`TEMPEST BOLT! · ${Math.max(0,bolts.stacks||0)} LEFT`,'info');this.resolve(caster,a,target,{tempestProc:true});return true;}if(instantProc){const hot=caster.has('instantBolt');this.float(caster,`INSTANT CINDER! · ${Math.max(1,hot.stacks||1)} READY`,'info');this.resolve(caster,a,target,{proc:true});return true;}if(a.cast>0){caster.cast={a,index,target,total:a.cast,left:a.cast,school:a.school,commitCooldown:commitOnComplete,moveCast:a.name==='Lullaby Bloom'};this.audio.play('cast');this.log(`${caster.name} begins ${a.name}.`);return true;}this.resolve(caster,a,target);return true;}
 completeCast(c,cst){if(cst?.a?.type==='stormkeeper')cst.target=c;/* STORMKEEPER_COMPLETE_SELF_TARGET */if(!c.alive||!cst.target.alive)return;if(cst.special==='mount'){if(this.isInCombat(c)){if(c===this.player)this.message('Cannot mount while in combat');return;}c.mounted=true;c.mountVisual.visible=true;this.vfxRing(c,c.mountData?.aura||0x78efff,2.1);this.audio.play('mountReady');if(c===this.player)this.message(`Mounted: ${(c.mountData||mountDefinition(progression.activeMount)).name}`);else this.float(c,'MOUNTED','info');return;}if(cst.target!==c&&isUntargetableStealth(cst.target,c)){if(c===this.player)this.message('TARGET VANISHED — cast cancelled');this.float(cst.target,'VANISHED','info');return;}if(cst.target!==c&&!this.arena.los(c,cst.target)){if(c===this.player)this.message('LINE OF SIGHT — cast failed');this.float(cst.target,'LINE OF SIGHT','error');this.vfxRing(cst.target,0xde503b,1.15);return;}if(dist(c,cst.target)>cst.a.range&&cst.target!==c){if(c===this.player)this.message('Out of range');return;}if(cst.commitCooldown)c.cds[cst.index]=cst.a.cd;if(cst.channel){this.float(c,'CHANNEL COMPLETE','info');return;}this.resolve(c,cst.a,cst.target);}
 channelTick(c,cst){if(!c.alive)return;if(cst.soulDrain&&!cst.uaRefreshed){const ua=cst.target?.has?.('unstableAffliction');if(ua&&ua.source===c){ua.time=10;ua.tick=Math.min(ua.tick||1,1);cst.uaRefreshed=true;this.float(cst.target,'UNSTABLE AFFLICTION REFRESHED','info');}}if(cst.discPenance){
   const t=cst.target;if(!t||!t.alive)return;
   cst.ticks=(cst.ticks||0)+1;
   if(t.team===c.team){this.heal(c,t,cst.a.directHeal||132,'Penance Direct Heal');this.vfxDisciplineStarBolt(c,t,{healing:true,penance:true,bolt:cst.ticks});this.vfxGlyph(t,0xffffff,.62);}
   else{const radiantMult=cst.radiantPenance?1.15:1;this.damage(c,t,Math.round(cst.a.value*radiantMult),cst.radiantPenance?'Radiant Penance':'Penance');const mult=(1+(talentRank(c.cls,'disc_penance')||0)*.06)*radiantMult;this.healAtonements(c,Math.round((cst.a.atonementHeal||78)*mult),cst.radiantPenance?'Radiant Penance Atonement':'Penance Atonement');this.vfxDisciplineStarBolt(c,t,{penance:true,bolt:cst.ticks});this.vfxGlyph(t,cst.radiantPenance?0xffffff:0xffe7ab,cst.radiantPenance?.72:.54);}
   if(t.team===c.team)this.audio.play('discPenance',c);return;
	  }if(cst.bladestorm){const radius=cst.radius||5.2;const victims=this.units.filter(u=>u.team!==c.team&&u.alive&&dist(c,u)<=radius&&this.arena.los(c,u));cst.ticks=(cst.ticks||0)+1;victims.forEach((t,i)=>{const hit=this.damage(c,t,cst.a.value,'Bladestorm Tick');if(hit){t.effect('slow',.75,{pct:.60,source:c,label:'Bladestorm'});this.float(t,cst.ticks===1?'BLADESTORM SLOW 60%':'','info');}this.vfxKickArc(t,i%2?0xffd36b:COLORS.warrior);});this.vfxCyclone(c,COLORS.warrior,.72);this.audio.playSample('fast_swing',{gain:.32,cooldown:180,source:c});return;}
   if(cst.soulDrain){
    const t=cst.target;if(!t||!t.alive)return;
    const uaStacks=t.has('unstableAffliction')?.stacks||0;
    const hasImmolate=t.effects.some(e=>e.type==='burn'&&e.label==='Immolate'&&e.source===c&&e.time>0);
    const afflictionPower=(t.has('soulScar')?1:0)+((t.has('agony')||hasImmolate)?1:0)+uaStacks;
    const amount=cst.a.value+afflictionPower*15;
    this.damage(c,t,amount,'Essence Siphon');this.heal(c,c,Math.round(amount*.575),'Essence Siphon');
    const chaosIndex=(AB[c.cls]||[]).findIndex(spell=>spell.type==='chaosBolt');
    if(chaosIndex>=0&&c.cds[chaosIndex]>0){c.cds[chaosIndex]=Math.max(0,c.cds[chaosIndex]-3);this.float(c,`CHAOS BOLT ${c.cds[chaosIndex]>0?c.cds[chaosIndex].toFixed(1)+'s':'READY'}`,'info');}
    this.vfxSiphonPulse(c,t,afflictionPower);this.audio.play('siphonTick',c);this.float(t,`DRAIN ${amount}`,'error');return;
   }
   const radius=cst.radius||5.0;const victims=this.units.filter(u=>u.team!==c.team&&u.alive&&dist(c,u)<=radius&&this.arena.los(c,u));cst.ticks=(cst.ticks||0)+1;this.vfxFuryPulse(c,radius,cst.ticks);if(!victims.length){if(c===this.player&&cst.ticks===1)this.message('No enemy caught in Fists of Fury');return;}victims.forEach((t,i)=>{const hit=this.damage(c,t,cst.a.value,'Fists of Fury');if(hit&&talentRank(c.cls,'wind_chi_wave')>0){this.damage(c,t,11,'Rushing Jade Wind');this.vfxSpiral(t,COLORS.wind,.42);c.effect('rushingJade',.8);} if(!hit)return;t.effect('slow',.72,{pct:.60,source:c,label:'Fists of Fury'});this.float(t,'FURY SLOW 60%','info');this.vfxKickArc(t,i%2?0xffdf79:COLORS.wind);this.vfxNova(t,0xffdf79,.64,3);this.float(t,cst.ticks===1?'PUMMELED':'PUMMEL','info');});this.audio.play('furyTick',c);}
 animateAction(c,a){if(!c||!a)return;const melee=['damage','dot','leap','singleStun','shadowInterrupt','windInterrupt','windStun','monkFinisher','fistsChannel','whirlingDragonPunch','mortalSwing','charge','rend','gushingWound','pummel'].includes(a.type)&&(a.school==='physical'||a.school==='shadow'||a.school==='wind');const support=['heal','hot','bigHeal','shield','spiritBlossom','ironbark','shieldSelf','cleanse','freedom','guardianAngel','holyLight','holyShock','sacrifice','intercept','sharpenBlade','paladinAoE','paladinGuard','bestowFaith','ghanir','discShield','discMend','painSuppression','ultimateRadiance','discFade','archangel','darkArchangel','angelicBody','avengingWings'].includes(a.type);c.combatAnim={type:melee?'melee':'spell',until:this.time+(support ? .42 : .34),dur:support ? .42 : .34};}

 applyAtonement(c,target,duration=14){
  if(!c||!target||!target.alive||target.team!==c.team)return;
  const bonus=talentRank(c.cls,'disc_evangelism')||0;
  target.effects=target.effects.filter(e=>!(e.type==='atonement'&&e.source===c));
  target.effect('atonement',duration+bonus,{source:c});
  this.vfxGlyph(target,COLORS.discipline,.62);
  this.vfxRing(target,0xe8e4ff,1.45);
  this.float(target,'ATONEMENT','heal');
 }
 healAtonements(c,amount,label='Atonement'){
  if(!c||c.cls!=='disc')return 0;
  amount*=1.25;/* Atonement conversion +25%. */
  if(c.has('archangel'))amount*=1.30;
  const allies=this.units.filter(u=>u.team===c.team&&u.alive&&u.effects.some(e=>e.type==='atonement'&&e.source===c));
  let total=0;
  allies.forEach((u,i)=>{const before=u.hp;this.heal(c,u,amount,label);total+=Math.max(0,u.hp-before);this.vfxGlyph(u,i%2?0xffe6a8:0xd8d3ff,.42);});
  if(allies.length)this.float(c,`ATONEMENT ×${allies.length}`,'heal');
  return total;
 }
 resolve(c,a,t,opts={}){this.animateAction(c,a);this.audio.playAbility(a,c);if(a.type==='volcanicEruption'&&t){this.vfxVolcanicEruption(t);this.audio.playSample('fire_impact',{gain:.72,rate:.78,cooldown:0,source:t});}if(t&&t!==c&&t.team!==c.team&&t.has?.('iceBlock')){this.float(t,'IMMUNE','info');return;}if(t&&t!==c&&t.team!==c.team&&t.has?.('cloakShadows')&&a.school!=='physical'&&!this.isMeleeStrike(a.name)&&!['Fists of Fury','Bladestorm'].includes(a.name)){this.float(t,'CLOAK IMMUNE','info');return;}if(c.cls==='storm'&&a.name!=='Arc Spark'&&a.name!=='Tempest Bolt'&&['chain','stun','root','push'].includes(a.type))c.effects=c.effects.filter(e=>e.type!=='arcSequence');let mult=(c.has('burst')?1.22:1)*(opts.proc?1.15:1)*(c.has('smokePower')?1.10:1);switch(a.type){
   case'damage':this.projectile(c,t,a.school,()=>{let v=a.value*mult,label=a.stormkeeperSpark?'Stormkeeper Arc Spark':a.name;if(a.name==='Pandemic Bloom'&&c.has('pandemicSurge')){v*=1.20;c.effects=c.effects.filter(e=>e.type!=='pandemicSurge');this.float(c,'PANDEMIC BLOOM +20%','info');this.vfxGlyph(c,COLORS.soul,.82);}if(a.name==='Cinder Bolt'&&c.has('instantBolt')){const ib=c.has('instantBolt');v*=1+Number(ib.pct||.20);ib.stacks=(ib.stacks||1)-1;this.float(c,'HOT STREAK +20%','info');if(ib.stacks<=0)c.effects=c.effects.filter(e=>e!==ib);}if(a.stormkeeperSpark&&c.has('stormkeeper')){const sk=c.has('stormkeeper');sk.stacks=(sk.stacks||3)-1;this.float(c,`FREE ARC SPARK · ${Math.max(0,sk.stacks)} LEFT`,'info');this.vfxGlyph(c,COLORS.storm,.82);this.vfxNova(t,COLORS.storm,1.35,12);if(sk.stacks<=0)c.effects=c.effects.filter(e=>e!==sk);}const evis=a.name==='Night Slash'&&!!c.has('eviscerateReady');
    if(a.name==='Ember Lance'&&t.has('burn')){v*=1.30;this.gainMana(c,6);}
    if(a.name==='Ember Lance'&&c.has('meteorLance')){const meteor=c.has('meteorLance');meteor.stacks=(meteor.stacks||2)-1;if(meteor.stacks<=0)c.effects=c.effects.filter(e=>e!==meteor);else meteor.time=9999;v*=Number(meteor.pct||.15)+1;this.float(c,`METEOR LANCE +${Math.round(Number(meteor.pct||.15)*100)}% · ${Math.max(0,meteor.stacks||0)} LEFT`,'info');this.vfxGlyph(c,COLORS.fire,.66);this.vfxNova(c,COLORS.fire,1.45,10);}
    if(evis){c.effects=c.effects.filter(e=>e.type!=='eviscerateReady');v*=1.45;label='Eviscerate';this.float(c,'EVISCERATE! +45%','info');this.vfxGlyph(c,0xd7b3ff,.66);}
    const hit=this.damage(c,t,v,label);if(a.risingSunProc&&hit){c.effects=c.effects.filter(e=>e.type!=='risingSunReady');this.vfxRisingSunKick(c,t);this.float(c,'RISING SUN KICK!','info');}
    if(a.name==='Cinder Bolt'&&hit){this.gainMana(c,4);if(c.has('burst'))t.effect('burn',4,{value:30/4,source:c});}
    if((a.name==='Judgement'||a.name==='Judgment')&&hit){this.gainMana(c,8);this.float(c,'+8 MANA','heal');this.vfxGlyph(c,COLORS.holy,.52);const allies=this.units.filter(u=>u.team===c.team&&u.alive&&dist(c,u)<=10);allies.forEach((u,i)=>{this.heal(c,u,101,'Judgement');this.vfxGlyph(u,0xffefb4,.34);if(i<2)this.vfxRing(u,COLORS.holy,1.15);});this.float(c,'JUDGEMENT HEALS ALLIES','heal');}if(a.name==='Arc Spark'&&hit){this.gainMana(c,4);this.rollStormSurge(c);}if(a.name==='Tempest Bolt'&&hit){this.gainMana(c,5);this.float(c,'+5 MANA','heal');this.vfxNova(t,COLORS.storm,1.22,10);}if(a.name==='Night Slash'&&hit){this.addShadowMark(c);if(evis){this.vfxNova(t,0xb56bff,1.38,10);this.vfxSpiral(t,0xecdcff,.7);}if(c.has('cheapReady')){c.effects=c.effects.filter(e=>e.type!=='cheapReady');if(t.cast)t.cast=null;c.effects=c.effects.filter(e=>e.type!=='stealth');t.effect('cheapStun',3);this.float(t,'CHEAP SHOT 3.0s','info');this.vfxGlyph(t,0x726080,.62);this.audio.play('stun');}}if(a.name==='Zephyr Palm'&&hit){this.addFlow(c,t);if(windTigereyeTalentActive(c)){c.tigereyePalmCounter=(c.tigereyePalmCounter||0)+1;if(c.tigereyePalmCounter>=2){c.tigereyePalmCounter=0;grantTigereyeStacks(c,2);}}}
   });break;
   case'livingBomb':t.effect('livingBomb',6,{value:a.value*mult,explodeValue:a.explodeValue||190,source:c,label:'Living Bomb'});this.vfxGlyph(t,COLORS.fire,.85);this.vfxOrbit(t,COLORS.fire,.9);this.float(t,'LIVING BOMB','error');break;    case'combustion':c.effect('combustion',8,{crit:.30,castSpeed:.15});this.spawnCombustionVisuals?.(c,8);this.vfxOrbit(c,COLORS.fire,1.9);this.vfxNova(c,COLORS.fire,3.0,28);this.vfxGlyph(c,COLORS.fire,1.05);this.float(c,'COMBUSTION — ENGULFED','info');this.audio.play('fire');break;    case'flameShield':this.applyShield(c,c,a.value||260,6);c.effect('moltenArmor',6,{value:14,source:c});this.shieldBubble(c,COLORS.fire,6);this.vfxGlyph(c,COLORS.fire,.9);this.float(c,'FIRE SHIELD','info');break;    case'chain':{const overloaded=!!c.has('overload');const surge=overloaded?1.35:1;if(overloaded){c.effects=c.effects.filter(e=>e.type!=='overload');this.float(c,'VOLCANIC OVERLOAD!','info');this.vfxGlyph(c,0xff9840,.92);this.vfxNova(c,0xffa242,2.15,16);}this.lightning(c,t);this.damage(c,t,a.value*mult*surge,a.name);this.units.filter(u=>u.team!==c.team&&u!==t&&u.alive&&dist(u,t)<8&&this.arena.los(t,u)).slice(0,2).forEach(u=>{this.lightning(t,u);this.damage(c,u,64*mult*surge,a.name);});if(overloaded)this.volcanicOverload(c,mult);this.gainMana(c,overloaded?10:6);if(overloaded)this.float(c,'+10 MANA','heal');break;}
   case'flameNova':this.units.filter(u=>u.team!==c.team&&u.alive&&dist(c,u)<=8&&this.arena.los(c,u)).forEach(u=>{const hit=this.damage(c,u,a.value,a.name);if(!hit)return;this.applyRoot(u,4);u.effect('slow',6,{pct:.60});this.vfxGlyph(u,0x92dfff,.65);this.vfxSpiral(u,0x8adfff,.7);this.float(u,'FROSTBITE 60%','info');});this.vfxRing(c,0x86d9ff,4);this.vfxNova(c,0x9ce9ff,2.6,18);this.float(c,'FROSTFIRE NOVA · OFF GCD','info');break;
   case'dash':this.dash(c,15,false,true);c.effect('trail',3,{value:12,source:c});if(c.cls==='flame')c.effect('defensive',2,{reduction:.20});this.vfxRing(c,COLORS.fire,1.8);break;
   case'interrupt':if(t.cast){if(t.cast.uninterruptible){this.float(t,'UNINTERRUPTIBLE','info');this.vfxGlyph(t,COLORS.wind,.58);this.log(`${t.name}'s Fists of Fury cannot be interrupted.`);}else if(t.has('interruptWard')){this.float(t,'INTERRUPT IMMUNE','info');this.vfxGlyph(t,COLORS.soul,.55);this.log(`${t.name}'s Soul Barrier prevented an interrupt.`);}else{const school=t.cast.school;t.cast=null;t.effect('lock_'+school,2.5);c.stats.interrupts++;const aftershock=unitTalentRank(c,'storm_aftershock');if(c.cls==='storm'&&aftershock>0){c.effects=c.effects.filter(e=>e.type!=='aftershockPower');c.effect('aftershockPower',10,{pct:aftershock*.02});this.float(c,`AFTERSHOCK · NEXT SPELL +${aftershock*2}%`,'info');}this.float(t,'INTERRUPTED','error');this.vfxRing(t,0xff9340,2.2);this.log(`${c.name} interrupted ${t.name}.`);}}break;
   case'interruptProc':if(t.cast){if(t.cast.uninterruptible){this.float(t,'UNINTERRUPTIBLE','info');this.vfxGlyph(t,COLORS.wind,.58);this.log(`${c.name}'s Counterflare could not stop ${t.name}'s Fists of Fury.`);}else if(t.has('interruptWard')){this.float(t,'INTERRUPT IMMUNE','info');this.vfxGlyph(t,COLORS.soul,.55);this.log(`${t.name}'s Soul Barrier prevented Counterflare.`);}else{const school=t.cast.school;t.cast=null;t.effect('lock_'+school,3);c.stats.interrupts++;c.resource=clamp(c.resource+20,0,c.maxResource);c.effect('instantBolt',8,{stacks:2,pct:.20});c.effect('interruptPower',8);this.audio.play('proc');this.float(t,'INTERRUPTED','error');this.float(c,'+20 MANA · HOT STREAK ×2','heal');this.vfxRing(t,0xff9340,2.4);this.log(`${c.name} countered ${t.name} and gained two empowered Hot Streak Cinder Bolts.`);}}else if(c===this.player){this.message('Target is not casting');}break;
   case'poly':this.projectile(c,t,'arcane',()=>{if(this.reflectControl(c,t,a.name,x=>{if(x.cast)x.cast=null;this.applyPoly(x,a.value||3.5);this.vfxGlyph(x,0xd9bbff,1.3);this.vfxSpiral(x,0xf7ecff,1.1);this.float(x,'HEXED — REFLECTED','info');}))return;if(t.cast)t.cast=null;this.applyPoly(t,a.value||3.5);this.vfxGlyph(t,0xd9bbff,1.3);this.vfxSpiral(t,0xf7ecff,1.1);this.float(t,'HEXED','info');});break;
   case'blind':{if(a.name==='Dragon Breath')this.applyCC(t,'blind',a.value||3,'DRAGON BREATH','disorient');else this.applyBlind(t,a.value||5);this.vfxGlyph(t,a.name==='Dragon Breath'?0xff9a53:0xd7c9ff,.86);this.vfxSpiral(t,a.name==='Dragon Breath'?0xff6b35:0xb86dff,.86);this.float(t,a.name==='Dragon Breath'?'DRAGON BREATH':'BLINDED','info');break;}
	   case'gouge':{this.applyGouge(t,a.value||3);this.vfxGlyph(t,0xd7c9ff,.72);this.float(t,'GOUGED · 3 SEC','info');break;}
   case'fear':this.projectile(c,t,'shadow',()=>{if(this.reflectControl(c,t,a.name,x=>{if(x.cast)x.cast=null;this.applyFear(x,a.value||5);{const fe=x.has('fear');if(fe){fe.source=x;fe.breakFromDots=false;}}this.vfxGlyph(x,0xcf84ff,.92);this.vfxSpiral(x,0x7a2ba8,1.05);this.float(x,'FEAR — REFLECTED','info');}))return;if(t.cast)t.cast=null;this.applyFear(t,a.value||5);{const fe=t.has('fear');if(fe){fe.source=c;fe.breakFromDots=c.cls==='soul'?false:true;}}if(a.name==='Mortal Horror'){this.heal(c,c,c.maxHp*.20,'Mortal Horror');this.float(c,'MORTAL HORROR · 20% HEAL','heal');}this.vfxGlyph(t,0xcf84ff,.92);this.vfxSpiral(t,0x7a2ba8,1.05);this.float(t,'FEARED','info');});break;
   case'windIncap':this.applyWindIncap(t,a.value||3);this.vfxGlyph(t,0x8ff4ce,.8);this.vfxSpiral(t,0xd7fff0,.8);this.vfxNova(t,COLORS.wind,1.15,8);this.float(t,'INCAPACITATED','info');break;
   case'sleep':this.projectile(c,t,'heal',()=>{if(this.reflectControl(c,t,a.name,x=>{if(x.cast)x.cast=null;this.applySleep(x,a.value||4.5);this.vfxGlyph(x,0xffd27d,1.2);this.vfxSpiral(x,0x83f2b4,1.2);this.float(x,'SLUMBER — REFLECTED','info');}))return;if(t.cast)t.cast=null;this.applySleep(t,a.value||4.5);this.vfxGlyph(t,0xffd27d,1.2);this.vfxSpiral(t,0x83f2b4,1.2);this.float(t,'SLUMBER','info');});break;
   case'leap':{const pounce=c.cls==='shadow'&&a.name==='Umbral Pounce';const cloudstep=c.cls==='wind'&&a.name==='Cloudstep Kick';const dashReady=cloudstep&&!!a.dashReady;if(!cloudstep||dashReady)this.moveAdjacent(c,t,dashReady);this.vfxTrail(c,c.cls==='wind'?COLORS.wind:0x6e38bc);if(pounce){c.effect('evasion',1.5,{pct:.50});this.float(c,'EVASION · 50% MELEE DODGE · 1.5s','info');}if(cloudstep){this.vfxKickArc(t,COLORS.wind);if(dashReady){c.effect('cloudstepDashCd',20);this.float(c,'CLOUDSTEP DASH! +20%','info');this.vfxOrbit(c,0xffdf79,.9);this.vfxNova(t,COLORS.wind,1.38,10);}}this.damage(c,t,a.value*mult,a.name);break;}
	   case'stormkeeper':c.effect('stormkeeper',10,{stacks:3});this.float(c,'STORMKEEPER · 3 FREE ARC SPARKS','info');this.vfxGlyph(c,COLORS.storm,1.1);this.vfxOrbit(c,COLORS.storm,1.35);this.audio.play('lightning');break;    case'frostShock':{const hit=this.damage(c,t,a.value*mult,a.name);if(hit){t.effects=t.effects.filter(e=>!(e.source===c&&['frostShockAmp'].includes(e.type)));t.effect('slow',8,{pct:.25,source:c,label:'Frost Shock'});t.effect('frostShockAmp',8,{pct:.15,source:c});this.vfxGlyph(t,0xa6f1ff,.62);this.float(t,'FROST SHOCK · 25% · ARC/FORK +15%','info');}break;}    case'totemMastery':c.effect('totemMastery',20);this.spawnTotemMasteryVisuals?.(c,20);this.vfxRing(c,COLORS.storm,3.0);this.vfxGlyph(c,COLORS.storm,.95);this.float(c,'TOTEM MASTERY · 20s','info');break;    case'windlordStrike':{const hit=this.damage(c,t,a.value*mult,a.name);if(hit){c.cds[1]=0;c.effect('windlordReady',8);c.effects=c.effects.filter(e=>e.type!=='risingSunReady');c.effect('risingSunReady',10);this.vfxWindlordStrike(c,t);this.vfxKickArc(t,0x9a65ff);this.vfxNova(t,0xffe277,1.9,18);this.float(c,'CLOUDSTEP RESET · RISING SUN READY','info');}break;}    case'chiBurst':this.projectile(c,t,'wind',()=>{const hit=this.damage(c,t,a.value*mult,a.name);if(hit)this.heal(c,c,Math.round(a.value*.75),'Chi Burst');});break;    case'karma':c.effect('touchKarma',4,{reflectPct:.50});c.effect('defensive',4,{reduction:.20});this.shieldBubble(c,COLORS.wind,4);this.vfxOrbit(c,COLORS.wind,1.25);this.float(c,'TOUCH OF KARMA · 50% REFLECT','info');break;    case'evasion':c.effect('evasion',8,{pct:.70});this.vfxOrbit(c,0xc499ff,1.05);this.float(c,'EVASION 70%','info');break;    case'vendetta':{t.effect('vendetta',10,{source:c});this.vfxGlyph(t,0xff315e,.95);this.vfxRing(t,0xff315e,2.15);this.vfxBurst(t,0x9b1024,.86);this.vfxSpiral(t,0xd61d3e,1.15);this.vfxNova(t,0x7a0015,1.45,10);this.float(t,'VENDETTA MARKED · 10 SEC','error');break;}    case'cloak':c.effects=c.effects.filter(e=>!['slow','root','burn','poison','bleed','livingBomb','karmaDot','soulScar','agony','unstableAffliction','flameShock','trail'].includes(e.type));c.effect('cloakShadows',5);this.applyShield(c,c,a.value||180,5);this.vfxGlyph(c,0xd7b3ff,1.0);this.vfxNova(c,0xa762ff,1.8,14);this.float(c,'CLOAK · MAGIC & DOT IMMUNITY','info');break;    case'internalBleeding':{if(!t.has('cheapStun')&&!t.has('stun')&&!t.has('furyStun')){if(c===this.player)this.message('Internal Bleeding requires Ribbreaker setup');break;}t.effect('bleed',6,{value:a.value*mult,source:c,label:'Internal Bleeding',interval:1});this.float(t,'INTERNAL BLEEDING','error');break;}    case'volcanicEruption':{c.effects=c.effects.filter(e=>e.type!=='volcanicEruptionReady');this.projectile(c,t,'fire',()=>{const hit=this.damage(c,t,a.value*mult,a.name);if(hit){this.vfxNova(t,0xff6f2f,2.2,20);this.vfxGlyph(t,0xffaa45,.82);this.float(t,'VOLCANIC ERUPTION','error');}});break;}case'flameShock':t.effect('flameShock',12,{value:a.value*mult,source:c,interval:1,label:'Flame Shock'});this.vfxBurst(t,0xff7a32,.48);this.vfxGlyph(t,0xff9a3d,.52);this.float(t,'FLAME SHOCK','error');break;case'soulDot':this.projectile(c,t,'shadow',()=>{t.effect('soulScar',15,{value:a.value*mult,source:c});this.vfxAfflictionApply(t,COLORS.soul,'scar');this.float(t,'SOUL SCAR','info');});break;
   case'agony':t.effect('agony',15,{value:a.value*mult,source:c,stacks:1});this.vfxAfflictionApply(t,0xcb75ff,'torment');this.float(t,'TORMENT','info');break;
   case'immolate':{const existing=t.effects.find(e=>e.type==='burn'&&e.label==='Immolate'&&e.source===c);if(existing){const rank=unitTalentRank(c,'soul_curse_weaving');if(rank>0){c.effects=c.effects.filter(e=>e.type!=='curseWeavingPower');c.effect('curseWeavingPower',10,{pct:rank*.02});this.float(c,`CURSE WEAVING · NEXT HIT +${rank*2}%`,'info');}}const hit=this.damage(c,t,a.value*mult,'Immolate');if(hit){t.effect('burn',8,{effectKey:`${c.netId}:Immolate`,value:(a.dotValue||22)*mult,source:c,label:'Immolate',interval:1,tick:1});this.vfxAfflictionApply(t,0xff7a24,'torment');this.vfxBurst(t,0xff5a18,.5);this.float(t,'IMMOLATE · 8 SEC','error');}break;}
   case'unstableAffliction':{let ua=t.has('unstableAffliction');if(!ua){ua=t.effect('unstableAffliction',10,{value:50*mult,source:c,stacks:1});}else{const rank=unitTalentRank(c,'soul_curse_weaving');if(rank>0){c.effects=c.effects.filter(e=>e.type!=='curseWeavingPower');c.effect('curseWeavingPower',10,{pct:rank*.02});this.float(c,`CURSE WEAVING · NEXT HIT +${rank*2}%`,'info');}ua.time=10;ua.tick=1;ua.source=c;ua.stacks=Math.min(3,(ua.stacks||1)+1);ua.value=([0,50,40,110/3][ua.stacks]||50)*mult;}this.vfxAfflictionApply(t,0xf06cff,'unstable');this.vfxNova(t,0xb85cff,1.45,8);this.float(t,`UNSTABLE AFFLICTION ×${ua.stacks||1}`,'info');break;}
	   case'shiv':{const hit=this.damage(c,t,a.value*mult,a.name);if(hit){t.effect('slow',4,{pct:.65});t.effect('shivPoisonAmp',8,{source:c,pct:.30});this.float(t,'SHIV · SLOW 4 SEC · POISON +30% FOR 8 SEC','info');this.vfxKickArc(t,COLORS.shadow);}}break;    case'dot':{const empowered=!!c.has('venomEdge');if(a.name==='Garrote'){const hit=this.damage(c,t,Math.round(a.value*.70)*mult,a.name);if(hit){t.effect('bleed',8,{value:46*mult,source:c,label:'Garrote',interval:(t.has('vendetta')&&t.has('vendetta').source===c)?.5:1});this.vfxBurst(t,0x9b1c31,.72);this.vfxSpiral(t,0xd33b55,.82);this.float(t,'GARROTE · HEAVY BLEED','error');}}else if(empowered){c.effects=c.effects.filter(e=>e.type!=='venomEdge');this.float(c,'VENOM FINISHER!','info');const hit=this.damage(c,t,(a.value+78)*mult,a.name);if(hit){t.effect('poison',8,{value:28*mult,source:c,interval:(t.has('vendetta')&&t.has('vendetta').source===c)?.5:1});this.vfxNova(t,0x7ce867,1.8,14);this.vfxSpiral(t,0xb84cff,1.0);this.audio.play('proc');}}else{const hit=this.damage(c,t,a.value*mult,a.name);if(hit){t.effect('poison',8,{value:14*mult,source:c,interval:(t.has('vendetta')&&t.has('vendetta').source===c)?.5:1});this.vfxBurst(t,0x8ce65b,.45);}}break;}    case'defensive':c.effect('defensive',4);if(c.cls==='shadow'){c.effect('smokePower',8);c.effect('cheapReady',8);c.effect('smokeBombReady',8);c.effect('stealth',8);this.float(c,'STEALTH · VEILED ASSAULT','info');this.vfxGlyph(c,0x7862a6,.78);}this.shieldBubble(c,0x7151a5,4);this.float(c,'VEIL','info');break;
   case'monkFinisher':{const empowered=!!c.has('tempestFlow');if(empowered){c.effects=c.effects.filter(e=>e.type!=='tempestFlow');this.float(c,'CYCLONE COMBO','info');const hit=this.damage(c,t,a.value*2.55*mult,a.name);if(hit){t.effect('slow',3,{pct:.35});this.vfxCyclone(t,COLORS.wind,1.0);this.vfxNova(t,0xffdd87,1.8,12);this.vfxOrbit(c,0xffe39a,1.25);this.audio.play('proc');}}else{const hit=this.damage(c,t,a.value*mult,a.name);if(hit)this.vfxKickArc(t,COLORS.wind);}break;}
   case'touchOfDeath':{
    t.effects=t.effects.filter(e=>!(e.type==='touchOfDeath'&&e.source===c));
    t.effect('touchOfDeath',5,{source:c,accumulated:0});
    this.vfxTouchOfDeathMark(t,5);this.vfxRing(t,0xff405d,2.0);
    this.float(t,'TOUCH OF DEATH · 5s','error');
    break;
   }
   case'meteor':{this.float(c,'METEOR INCOMING','info');this.vfxGlyph(c,COLORS.fire,.85);this.dropMeteor(c,t.x,t.z);break;}
   case'whirlingDragonPunch':{const victims=this.units.filter(u=>u.team!==c.team&&u.alive&&dist(c,u)<=5.5&&this.arena.los(c,u));victims.forEach((u,i)=>{this.damage(c,u,a.value*mult,a.name);this.vfxKickArc(u,i%2?0xb7ff8b:COLORS.wind);});this.vfxWhirlingDragonPunch(c,.85);this.vfxNova(c,COLORS.wind,2.1,18);this.float(c,'WHIRLING DRAGON PUNCH','info');break;}
   case'stormbolt':{
    this.projectile(c,t,'stormbolt',()=>{if(!t.alive)return;this.applyStun(t,a.value||3);this.vfxGlyph(t,0xb778ff,.9);this.vfxNova(t,0x8f55ff,1.65,14);this.float(t,'STORMBOLT','error');});
    break;
   }
   case'windInterrupt':{const hit=this.damage(c,t,a.value*mult,a.name);if(hit){this.vfxKickArc(t,COLORS.wind);if(t.cast){if(t.cast.uninterruptible){this.float(t,'UNINTERRUPTIBLE','info');this.vfxGlyph(t,COLORS.wind,.58);this.log(`${c.name}'s Disrupting Palm could not interrupt ${t.name}'s Fists of Fury.`);}else if(t.has('interruptWard')){this.float(t,'INTERRUPT IMMUNE','info');this.vfxGlyph(t,COLORS.soul,.55);this.log(`${t.name}'s Soul Barrier prevented Disrupting Palm.`);}else{const school=t.cast.school;t.cast=null;t.effect('lock_'+school,3);c.stats.interrupts++;this.addFlow(c);this.float(t,'PALM INTERRUPT','error');this.float(c,'FLOW +1','info');this.vfxGlyph(t,COLORS.wind,.58);this.audio.play('interrupt');this.log(`${c.name} interrupted ${t.name} with Disrupting Palm.`);}}}break;}
   case'shadowInterrupt':{const hit=this.damage(c,t,a.value*mult,a.name);if(hit){this.vfxKickArc(t,COLORS.shadow);if(t.cast){if(t.cast.uninterruptible){this.float(t,'UNINTERRUPTIBLE','info');this.vfxGlyph(t,COLORS.wind,.58);this.log(`${c.name}'s Shadow Kick could not interrupt ${t.name}'s Fists of Fury.`);}else if(t.has('interruptWard')){this.float(t,'INTERRUPT IMMUNE','info');this.vfxGlyph(t,COLORS.soul,.55);this.log(`${t.name}'s Soul Barrier prevented Shadow Kick.`);}else{const school=t.cast.school;t.cast=null;t.effect('lock_'+school,3);c.stats.interrupts++;this.float(t,'SHADOW KICK','error');this.vfxGlyph(t,COLORS.shadow,.68);this.audio.play('interrupt');this.log(`${c.name} interrupted ${t.name} with Shadow Kick.`);}}}break;}
   case'windStun':this.units.filter(u=>u.team!==c.team&&u.alive&&dist(c,u)<=5.4).forEach(u=>{const hit=this.damage(c,u,a.value*mult,a.name);if(hit){this.applyStun(u,5);this.vfxKickArc(u,COLORS.wind);}});this.vfxCyclone(c,COLORS.wind,.86);this.vfxNova(c,COLORS.wind,1.4,10);break;
   case'monkDefensive':c.effect('defensive',6,{reduction:.50});this.heal(c,c,135,'Willow Guard');this.shieldBubble(c,COLORS.wind,6);this.vfxWillowGuard(c,6);this.vfxRing(c,COLORS.wind,3.4);this.vfxNova(c,COLORS.wind,2.2,18);this.vfxGlyph(c,COLORS.wind,1.05);this.float(c,'WILLOW GUARD · 30% WALL','info');break;
   case'slow':{const hit=this.damage(c,t,a.value*mult,a.name);if(hit){if(a.name==='Disabling Reach'){this.applySnareDR(t,4,.60,'DISABLING REACH 60%');this.vfxKickArc(t,COLORS.wind);}else{t.effect('slow',3,{pct:.45});this.float(t,'SLOWED','info');}}break;}
   case'stun':{let landed=false;this.units.filter(u=>u.team!==c.team&&u.alive&&dist(c,u)<=7).forEach(u=>{landed=this.damage(c,u,a.value*mult,a.name)||landed;this.applyStun(u,4);});if(c.cls==='storm'&&a.name==='Skybreaker Pulse'&&landed){c.effects=c.effects.filter(e=>e.type!=='volcanicEruptionReady');c.effect('volcanicEruptionReady',30);this.float(c,'VOLCANIC ERUPTION READY','info');this.vfxGlyph(c,0xff8738,.92);}this.vfxRing(c,COLORS.storm,4);break;}
   case'groundStun':{const radius=a.radius||4.5,duration=a.duration||3,x=t.x,z=t.z;let landed=0;this.units.filter(u=>u.team!==c.team&&u.alive&&Math.hypot(u.x-x,u.z-z)<=radius&&this.arena.los(c,u)).forEach(u=>{if(this.damage(c,u,a.value*mult,a.name)){this.applyStun(u,duration);landed++;this.vfxGlyph(u,0xb35bff,.75);this.vfxNova(u,0x6c239f,1.35,10);}});c.effects=c.effects.filter(e=>e.type!=='pandemicSurge');c.effect('pandemicSurge',8,{pct:.20});this.vfxRing({x,z},0xb35bff,radius);this.vfxNova({x,z},0x6c239f,2.4,20);this.float(c,'PANDEMIC BLOOM +20%','info');this.log(`${c.name} placed Shadowfury, stunning ${landed} enem${landed===1?'y':'ies'} for ${duration} sec.`);break;}
	   case'singleStun':{const hit=this.damage(c,t,a.value*mult,a.name);if(hit){this.applyStun(t,a.name==='Ribbreaker'?4:6);c.effect('eviscerateReady',10);this.float(c,'EVISCERATE READY','info');this.vfxGlyph(c,0xc398ff,.72);this.vfxRing(t,0xb35bff,2.1);if(c.cls==='shadow'){c.effects=c.effects.filter(e=>e.type!=='stealth');}if(c.cls==='shadow'&&a.name==='Ribbreaker'&&unitTalentRank(c,'shadow_shadowstep')>0){t.effect('bleed',6,{value:28.1*mult,source:c,label:'Internal Bleeding',interval:1});this.float(t,'INTERNAL BLEEDING · 6 SEC','error');this.vfxBurst(t,0x9b1c31,.45);}if(c.has('smokeBombReady')){c.effects=c.effects.filter(e=>e.type!=='smokeBombReady');t.effect('smokeBomb',5);this.smokeBombShroud(t,5);this.float(t,'SMOKE BOMB — NO HEALS','error');this.log(`${c.name} shrouded ${t.name} in Smoke Bomb.`);}}break;}
   case'root':{const landed=this.applyRoot(t,a.value||4);if(a.school==='nature'){if(landed)this.vfxEntanglingRoots(t,t.has('root')?.time||a.value||4);this.vfxRing(t,0x9be24f,2.2);this.vfxGlyph(t,0x7fd13c,.85);}else{this.vfxRing(t,COLORS.storm,2.2);this.vfxGlyph(t,0x62d8ff,.85);this.vfxSpiral(t,0xa6f1ff,.7);}break;}
	   case'shieldSelf':{const shieldAmount=a.percentShield?c.maxHp*a.value:a.value;this.applyShield(c,c,shieldAmount,6);if(c.cls==='storm'){c.effect('staticAegisGuard',6,{reduction:.20});this.float(c,'STATIC AEGIS · 20% WALL','info');}if(c.cls==='soul'){c.effect('interruptWard',6);this.vfxGlyph(c,COLORS.soul,.8);this.float(c,a.percentShield?'DARK PACT · 20% HEALTH SHIELD':'INTERRUPT IMMUNE','info');}break;}
   case'iceBlock':c.effects=c.effects.filter(e=>!['furyStun','cheapStun','stun','root','fear','poly','sleep','gouge','blind','windIncap','slow'].includes(e.type));c.effect('iceBlock',8,{value:c.maxHp*.025,source:c});c.cast=null;this.vfxIceBlock(c,8);this.vfxGlyph(c,0xdbf7ff,1.0);this.vfxRing(c,0xb9eaff,2.4);this.float(c,'ICE BLOCK — CC BROKEN','info');break;
   case'push':{const near=this.closestEnemy(c);if(near&&dist(c,near)<=9){let dx=near.x-c.x,dz=near.z-c.z,l=Math.hypot(dx,dz)||1;near.x+=dx/l*6;near.z+=dz/l*6;this.arena.constrain(near);this.vfxRing(near,COLORS.storm,1.8);}else this.dash(c,5,true);break;}
   case'tigersLust':{
     c.effects=c.effects.filter(e=>!['slow','root'].includes(e.type));
     c.effect('tigersLust',4,{speed:1.6});
     this.vfxRing(c,COLORS.wind,1.9);
     this.vfxOrbit(c,COLORS.wind,1.1);
     this.float(c,"TIGER'S LUST",'info');
     break;
    }
    case'tigereyeBrew':{
     const stacks=windTigereyeStacks(c);
     if(stacks<=0){if(c===this.player)this.float(c,'NO BREW STACKS','bad');c.cds[index]=0;break;}
     const power=Math.floor(stacks/2)*.10;
     c.tigereyeStacks=0;
     this.renderActions?.();
     c.effect('tigereyeBrew',6,{power,stacks});
     this.vfxRing(c,COLORS.wind||0x7dff8b,2.4);
     this.float(c,`TIGEREYE ${Math.round(power*100)}%`,'buff');
     break;
    }
    case'avatar':{const rooted=!!c.has('root');c.effects=c.effects.filter(e=>e.type!=='root');c.effect('avatar',10,{damagePct:.18});this.vfxAvatarForm(c,10);this.vfxRing(c,COLORS.warrior,3.2);this.vfxNova(c,COLORS.warrior,2.2,18);this.vfxGlyph(c,COLORS.warrior,1.0);this.audio.play('warriorBlade',c);this.float(c,rooted?'AVATAR · ROOT BROKEN':'AVATAR · STONE FORM · +18% DAMAGE','info');break;}
    case'sharpenBlade':c.effects=c.effects.filter(e=>e.type!=='sharpenBladeReady');c.effect('sharpenBladeReady',15);this.vfxGlyph(c,0xf04479,.9);this.vfxKickArc(c,0xf06a9a);this.float(c,'SHARPEN BLADE · NEXT MORTAL SWING','info');break;
    case'intercept':{this.moveAdjacent(c,t,true);this.vfxTrail(c,COLORS.warrior);t.effects=t.effects.filter(e=>e.type!=='interceptGuard');t.effect('interceptGuard',4,{source:c});this.shieldBubble(t,COLORS.warrior,4);this.vfxGlyph(t,COLORS.warrior,.9);this.vfxRing(t,COLORS.warrior,2.25);this.float(t,'INTERCEPT · DAMAGE REDIRECTED','info');this.log(`${c.name} intercepts all incoming damage for ${t.name} for 4 sec.`);break;}
   case'buff':{this.gainMana?.(c,20);c.effect('defensive',3,{reduction:.12});this.vfxRing(c,c.cls==='storm'?COLORS.storm:COLORS.warrior,2.0);this.float(c,'UTILITY BUFF','info');break;}    case'archangel':c.effects=c.effects.filter(e=>!['archangel','darkArchangel'].includes(e.type));c.effect('archangel',12,{atonementBonus:.30});this.vfxGlyph(c,0xffffff,1.05);this.vfxRing(c,0xffefb0,3.2);this.vfxNova(c,0xe8e1ff,2.1,18);this.float(c,'ARCHANGEL · ATONEMENT +30%','heal');break;
   case'darkArchangel':c.effects=c.effects.filter(e=>!['archangel','darkArchangel'].includes(e.type));c.effect('darkArchangel',12,{damagePct:.30});this.vfxGlyph(c,0x9b50ff,1.05);this.vfxRing(c,0x8a3cff,3.2);this.vfxNova(c,0x45225f,2.1,18);this.float(c,'DARK ARCHANGEL · DAMAGE +30%','info');break;
   case'angelicBody':c.effect('angelicBody',5,{speed:1.30});this.vfxGlyph(c,0xffffff,.85);this.vfxRing(c,0xe7e4ff,2.4);this.vfxTrail(c,0xffffff);this.float(c,'ANGELIC BODY · +30% SPEED','info');break;
   case'discSmite':{const hit=this.damage(c,t,a.value,'Smite');if(hit){this.healAtonements(c,a.atonementHeal||112,'Smite Atonement');this.projectile(c,t,'holy',()=>{});this.vfxGlyph(t,0xfff2b8,.52);}break;}
   case'discShield':{this.applyShield(c,t,a.value,8);this.applyAtonement(c,t,a.atonementDuration||14);this.shieldBubble(t,0xe8ecff,8);this.vfxGlyph(t,COLORS.discipline,.78);this.float(t,'POWER SHIELD','heal');break;}
   case'discMend':this.heal(c,t,a.value,'Shadow Mend');this.applyAtonement(c,t,14);if(c===t){t.effects=t.effects.filter(e=>e.type!=='shadowMendGuard');t.effect('shadowMendGuard',4,{reduction:.10,source:c});this.vfxRing(t,0xd8cbef,1.75);this.float(t,'SHADOW MEND · 10% GUARD','info');}this.vfxGlyph(t,0xc8b4dc,.62);this.vfxSpiral(t,0x8c6ca3,.55);break;
   case'discSolace':{const hit=this.damage(c,t,a.value,'Solace');if(hit){this.vfxDisciplineStarBolt(c,t,{penance:false,solace:true});this.healAtonements(c,a.atonementHeal||132,'Solace Atonement');this.gainMana(c,7+(talentRank(c.cls,'disc_solace')||0)*2);this.vfxNova(t,0xffeeb0,1.05,9);this.float(c,'SOLACE · MANA','heal');}break;}
   case'painSuppression':t.effects=t.effects.filter(e=>e.type!=='painSuppression'&&!(e.type==='defensive'&&e.label==='Pain Suppression'));t.effect('painSuppression',5,{source:c,label:'Pain Suppression'});t.effect('defensive',5,{reduction:.60,source:c,label:'Pain Suppression'});this.shieldBubble(t,0xe3dcff,5);this.vfxGlyph(t,COLORS.discipline,1.1);this.vfxRing(t,0xffe99a,2.7);this.vfxNova(t,0xd8c8ff,1.8,16);this.vfxPainSuppression(t,5);this.float(t,'PAIN SUPPRESSION · 60%','info');break;
   case'ultimateRadiance':{const rank=talentRank(c.cls,'disc_radiance')||0;const amount=Math.round(a.value*(1+rank*.06));const allies=this.units.filter(u=>u.team===c.team&&u.alive);allies.forEach((u,i)=>{this.heal(c,u,amount,'Ultimate Radiance');this.applyAtonement(c,u,a.atonementDuration||10);this.vfxNova(u,i%2?0xffe89a:0xdad5ff,1.4,12);});c.effects=c.effects.filter(e=>e.type!=='radiantPenanceProc');c.effect('radiantPenanceProc',12,{stacks:1,damageBonus:.15,atonementBonus:.15,speedBonus:.30});this.vfxRing(c,COLORS.discipline,4.2);this.vfxGlyph(c,COLORS.discipline,1.35);this.vfxNova(c,0xffffff,2.4,20);this.float(c,'RADIANT PENANCE READY','heal');break;}
   case'discFear':this.units.filter(u=>u.team!==c.team&&u.alive&&dist(c,u)<=8&&this.arena.los(c,u)).forEach(u=>{this.applyFear(u,a.value||4);const fe=u.has('fear');if(fe){fe.source=c;fe.breakFromDots=true;}this.vfxGlyph(u,0xdccfff,.65);this.vfxSpiral(u,0x9275b7,.75);});this.vfxRing(c,COLORS.discipline,3.8);this.float(c,'PSYCHIC SCREAM','info');break;
   case'discFade':c.effect('discFade',4,{reduction:.30,speed:1.25});c.effect('defensive',4,{reduction:.30,source:c,label:'Fade'});this.vfxGlyph(c,COLORS.discipline,.9);this.vfxRing(c,0xffffff,2.3);this.vfxNova(c,0xd8d7ff,1.45,12);this.float(c,'FADE','info');break;
   case'heal':{let amount=a.value;const renewal=c.has('renewalVerdant');if(a.name==='Verdant Mend'&&renewal){amount*=2.5;c.effects=c.effects.filter(e=>e!==renewal);this.float(c,'RENEWAL-EMPOWERED VERDANT MEND · +150%','heal');this.vfxGlyph(c,COLORS.heal,.9);this.vfxNova(t,COLORS.heal,1.7,14);}this.heal(c,t,amount,a.name);this.healBolt(c,t);break;}
   case'hot':{this.heal(c,t,a.value,a.name);const fast=!!c.has('ghanir');t.effect('hot',12,{effectKey:`${c.cls}:${a.name}`,value:a.tickValue||23,source:c,label:a.name,interval:1,tick:fast?.5:1});this.healBolt(c,t);break;}
   case'shield':this.applyShield(c,t,a.value,7);break;
   case'spiritBlossom':this.plantSpiritBlossom(c,t,9,6,a.value,23);break;
   case'ironbark':t.effects=t.effects.filter(e=>e.type!=='ironbark');t.effect('ironbark',6,{healingTaken:.20,source:c,label:'Ironbark'});t.effect('defensive',6,{reduction:.20,source:c,label:'Ironbark'});this.vfxIronbark(t,6);this.vfxGlyph(t,COLORS.heal,.82);this.vfxRing(t,COLORS.heal,2.35);this.float(t,'IRONBARK · 20% WALL · HEALING +20%','info');break;
   case'ghanir':c.effects=c.effects.filter(e=>e.type!=='ghanir');c.effect('ghanir',7,{hotBonus:.50,hotInterval:.50});this.vfxGhanir(c,7);this.vfxGlyph(c,COLORS.heal,1.1);this.float(c,"G'HANIR · HOTS +50% · TICKS 50% FASTER",'heal');break;case'natureSwiftness':{c.effects=c.effects.filter(e=>e.type!=='natureSwiftness');c.effect('natureSwiftness',8,{buff:true});this.vfxGlyph(c,COLORS.heal,1.0);this.vfxRing(c,COLORS.heal,2.7);this.vfxNova(c,COLORS.heal,1.8,14);this.float(c,'NATURE SWIFTNESS · CHOOSE RENEWAL OR LULLABY','heal');break;}
   case'undyingResolve':c.effect('defensive',5,{reduction:.50,source:c,label:'Undying Resolve'});this.vfxUndyingResolve(c,5);this.shieldBubble(c,COLORS.soul,5);this.vfxGlyph(c,COLORS.soul,1.25);this.vfxRing(c,COLORS.soul,3.5);this.vfxNova(c,COLORS.soul,2.7,24);this.float(c,'UNDYING RESOLVE · 50% WALL','info');break;
   case'bigHeal':this.heal(c,t,a.value,a.name);if(a.name==='Renewal Tide'){c.effects=c.effects.filter(e=>e.type!=='renewalVerdant');c.effect('renewalVerdant',9999,{pct:1.5});this.float(c,'VERDANT MEND EMPOWERED · +150%','heal');this.vfxOrbit(c,COLORS.heal,1.1);}this.vfxRing(t,COLORS.heal,2.5);break;
   case'cleanse':{const removed=t.removeDispellable();const col=c.cls==='pala'?COLORS.holy:COLORS.heal;this.float(t,removed?`DISPELLED ${effectMeta(removed).label.toUpperCase()}`:'NO DISPELLABLE EFFECT','info');this.vfxBurst(t,col,.68);this.vfxGlyph(t,col,.58);if(c.cls!=='sage')this.audio.play('shield');break;}
   case'healerEscape':this.dash(c,9,true);c.effect('defensive',3,{reduction:.30});this.vfxRing(c,COLORS.heal,2.2);this.float(c,'FAE RETREAT · 9m','info');break;
   case'holyLight':this.heal(c,t,a.value,a.name);this.healBolt(c,t);this.vfxGlyph(t,COLORS.holy,.52);break;
   case'holyShock':{const hostile=t.team!==c.team,shots=Math.max(1,a.shots||1);let anyCritical=false;for(let shot=0;shot<shots;shot++){const critical=Math.random()<this.criticalStrikeChance(c,.35);anyCritical=anyCritical||critical;const base=hostile?(a.damageValue||112):a.value;const value=critical?Math.round(base*1.5):base;const label=shots>1?`Divine Toll Holy Shock ${shot+1}`:a.name;if(hostile){this.damage(c,t,value,label);this.vfxGlyph(t,COLORS.holy,.64);this.float(t,critical?'HOLY SHOCK CRIT!':'HOLY SHOCK','damage');}else{this.heal(c,t,value,label);this.float(t,critical?'HOLY SHOCK CRIT!':'HOLY SHOCK','heal');}this.vfxRing(t,COLORS.holy,1.8+shot*.18);this.vfxNova(t,COLORS.holy,1.1+shot*.12,10);}if(anyCritical){c.effects=c.effects.filter(e=>e.type!=='infusion');c.effect('infusion',10);this.float(c,'INFUSION OF LIGHT!','info');this.vfxOrbit(c,0xffe59a,1.25);this.vfxGlyph(c,COLORS.holy,.88);this.audio.play('infusion');}if(shots>1)this.float(t,'DIVINE TOLL · 3 HOLY SHOCKS','heal');break;}
   case'avengingWings':c.effects=c.effects.filter(e=>e.type!=='avengingWings');c.effect('avengingWings',8,{healingBonus:.20,damageBonus:.20});this.vfxAvengingWings(c,8);this.vfxGlyph(c,COLORS.holy,1.0);this.float(c,'AVENGING WINGS · +20% DAMAGE & HEALING','info');break;case'sacrifice':t.effects=t.effects.filter(e=>e.type!=='sacrifice');t.effect('sacrifice',6,{source:c});c.effects=c.effects.filter(e=>e.type!=='avengingWings');c.effect('avengingWings',6,{healingBonus:.20});this.shieldBubble(t,COLORS.holy,6);this.vfxGlyph(t,COLORS.holy,.84);this.vfxAvengingWings(c,6);this.float(t,'SACRIFICE PROTECTED','info');this.float(c,'AVENGING WINGS · +20% HEALING','heal');this.audio.play('infusion');this.log(`${c.name} protects ${t.name} with Blessing of Sacrifice and gains Avenging Wings.`);break;
   case'bestowFaith':t.effects=t.effects.filter(e=>e.type!=='bestowFaith');t.effect('bestowFaith',4,{source:c,value:a.value||240});this.vfxGlyph(t,COLORS.holy,.72);this.vfxRing(t,COLORS.holy,1.55);this.float(t,'BESTOW FAITH · 4s','info');break;case'paladinAoE':break;
   case'paladinGuard':c.effect('defensive',6,{reduction:.30});this.shieldBubble(c,COLORS.holy,6);this.vfxOrbit(c,0xffde78,1.0);this.float(c,'DIVINE PROTECTION · 6s','info');break;
   case'paladinStun':if(this.reflectControl(c,t,a.name,x=>{this.applyStun(x,a.value||4.5);this.vfxGlyph(x,COLORS.holy,.78);this.vfxRing(x,COLORS.holy,1.85);this.float(x,'HAMMER — REFLECTED','info');}))break;this.applyStun(t,a.value||4.5);this.vfxGlyph(t,COLORS.holy,.78);this.vfxRing(t,COLORS.holy,1.85);this.float(t,'HAMMER OF JUSTICE','info');break;
   case'paladinSteed':c.effects=c.effects.filter(e=>e.type!=='divineSteed');c.effect('divineSteed',3,{speed:1.65});this.vfxDivineSteed(c,3);this.vfxRing(c,COLORS.holy,2.45);this.vfxGlyph(c,COLORS.holy,.78);this.float(c,'DIVINE STEED','info');break;
   case'mortalSwing':{const emp=c.has('empoweredSwing'),wb=c.has('warbreakerReady'),sharpen=c.has('sharpenBladeReady');const wbMult=wb?1.30:1;let hit=false;if(wb){c.effects=c.effects.filter(e=>e!==wb);this.float(c,'WARBREAKER · NEXT SWING CONSUMED','info');this.vfxGlyph(c,COLORS.warrior,.72);}if(emp){const talentBonus=(talentRank(c.cls,'war_pummel_chain')||0)*.02;const v=a.value*(1.30+talentBonus)*wbMult*mult;hit=this.damage(c,t,v,'Mortal Swing');this.vfxKickArc(t,COLORS.warrior);this.vfxNova(t,COLORS.warrior,1.15,8);c.effects=c.effects.filter(e=>e!==emp);this.float(c,'PUMMEL EMPOWERED · +30%','info');}else{hit=this.damage(c,t,a.value*wbMult*mult,'Mortal Swing');this.vfxKickArc(t,COLORS.warrior);}if(hit&&sharpen){c.effects=c.effects.filter(e=>e!==sharpen);t.effects=t.effects.filter(e=>e.type!=='sharpenedWound');t.effect('sharpenedWound',3,{source:c,reduction:.40});c.effects=c.effects.filter(e=>e.type!=='sharpenRenewal');c.effect('sharpenRenewal',3.05,{tick:.05,interval:1,ticks:3});this.vfxGlyph(t,0xf04479,.78);this.vfxRing(t,0xd72861,1.7);this.float(t,'SHARPENED WOUND · HEALING -40%','error');this.float(c,'SHARPEN RENEWAL · 9%','heal');}if(hit&&wb){c.effects=c.effects.filter(e=>e.type!=='slicingWinds');c.effect('slicingWinds',1.02,{tick:.08,interval:.30,ticks:3,target:t,value:a.value*.60*mult,slashIndex:0});this.float(c,'SLICING WINDS ×3 · 60%','info');}break;}
   case'charge':{this.moveAdjacent(c,t,true);this.vfxTrail(c,COLORS.warrior);const holdRank=unitTalentRank(c,'war_hold_the_line');if(holdRank>0){c.effects=c.effects.filter(e=>e.type!=='holdTheLine');c.effect('holdTheLine',3,{reduction:holdRank*.02});this.vfxGlyph(c,COLORS.warrior,.5);this.float(c,`HOLD THE LINE · ${holdRank*2}% WALL`,'info');}const hit=this.damage(c,t,a.value*mult,'Charge');if(hit){this.applyRoot(t,1.5);t.effect('slow',4,{pct:.45,source:c,label:'Charge Snare'});this.vfxRing(t,COLORS.warrior,1.7);this.float(t,'ROOTED → HAMSTRUNG','info');}this.float(c,'CHARGE!','info');break;}
   case'rend':{const hit=this.damage(c,t,a.value*mult,'Rend');if(hit){const bleed=t.effect('bleed',9,{value:Math.round(33*mult),source:c,interval:1,label:'Rend'});bleed.tick=1;this.vfxAfflictionApply(t,COLORS.warrior,'torment');this.float(t,'REND','info');if(Math.random()<.30){c.effect('gushingWoundReady',10);c.cds[2]=0;this.float(c,'GUSHING WOUND READY!','info');this.vfxGlyph(c,0xff284f,.82);this.vfxOrbit(c,0xff284f,.86);this.audio.play('proc');}}break;}    case'gushingWound':{c.effects=c.effects.filter(e=>e.type!=='gushingWoundReady');const hit=this.damage(c,t,a.value*mult,'Gushing Wound');if(hit){let bleed=t.has('bleed');if(!bleed)bleed=t.effect('bleed',6,{value:Math.round(26.4*mult),source:c,interval:.5,label:'Gushing Wound'});bleed.time=Math.max(bleed.time,6);bleed.value=Math.round(26.4*mult);bleed.source=c;bleed.interval=.5;bleed.tick=Math.min(bleed.tick||.5,.14);bleed.label='Gushing Wound';this.vfxAfflictionApply(t,0xff284f,'torment');this.vfxNova(t,0xff2548,1.7,14);this.vfxSpiral(t,0xb70d31,.9);this.float(t,'GUSHING WOUND!','error');this.audio.play('proc');}break;}
   case'pummel':{const hit=this.damage(c,t,a.value*mult,'Pummel');if(hit)this.vfxKickArc(t,COLORS.warrior);if(t.cast){if(t.cast.uninterruptible){this.float(t,'UNINTERRUPTIBLE','info');this.vfxGlyph(t,COLORS.wind,.58);}else if(t.has('interruptWard')){this.float(t,'INTERRUPT IMMUNE','info');this.vfxGlyph(t,COLORS.soul,.55);}else{const school=t.cast.school;t.cast=null;t.effect('lock_'+school,3);c.stats.interrupts++;c.effect('empoweredSwing',12,{stacks:1,pct:.30});this.float(t,'PUMMELED · SCHOOL LOCKED 3s','error');this.float(c,'MORTAL SWING +30% READY','info');this.vfxRing(t,COLORS.warrior,2.2);this.vfxGlyph(c,COLORS.warrior,.7);this.audio.play('interrupt');this.log(c.name+' pummeled '+t.name+' and readies one +30% Mortal Swing.');}}else if(c===this.player){this.message('Target is not casting');}break;}
   case'reflect':c.effect('reflect',2.5);this.shieldBubble(c,0x78dfff,2.5);this.vfxReflectWard(c,2.5);this.vfxGlyph(c,0xa7efff,1.0);this.vfxOrbit(c,0x78dfff,1.35);this.vfxNova(c,0xb9f3ff,1.8,12);this.float(c,'SPELL REFLECT READY · 2.5s','info');break;
   case'shout':this.units.filter(u=>u.team!==c.team&&u.alive&&dist(c,u)<=8&&this.arena.los(c,u)).forEach(u=>{this.applyFear(u,a.value||4);{const fe=u.has('fear');if(fe){fe.source=c;fe.breakFromDots=true;}}this.vfxGlyph(u,COLORS.warrior,.7);this.vfxSpiral(u,0x7a2ba8,.9);});this.vfxRing(c,COLORS.warrior,4);this.vfxNova(c,COLORS.warrior,1.6,12);this.float(c,'INTIMIDATING SHOUT','info');break;
   case'bladestorm':break;    case'victoryRush':{const hit=this.damage(c,t,a.value*mult,a.name);if(hit){const vr=c.has('victoryRushBoost');const heal=(a.healValue||185)*(vr?1.60:1);if(vr)c.effects=c.effects.filter(e=>e!==vr);this.heal(c,c,heal,'Victory Rush');this.vfxGlyph(c,COLORS.warrior,.68);this.float(c,vr?'VICTORY RUSH +60%':'VICTORY RUSH HEAL','heal');}break;}    case'warbreaker':{const hit=this.damage(c,t,a.value*mult,a.name);if(hit){c.effect('warbreakerReady',10,{pct:.30});this.vfxGlyph(c,COLORS.warrior,.75);this.vfxRing(t,COLORS.warrior,1.8);this.float(c,'WARBREAKER READY · NEXT MORTAL SWING +30%','info');}break;}    case'warriorGuard':c.effect('defensive',6,{reduction:.60,damagePenalty:.25});c.effect('victoryRushBoost',12,{pct:.60});this.shieldBubble(c,COLORS.warrior,6);this.vfxShieldWall(c,6);this.float(c,'SHIELD WALL · VICTORY RUSH PRIMED','info');break;
  }}
 isMeleeStrike(label){return ['Night Slash','Eviscerate','Umbral Pounce','Viper Cut','Ribbreaker','Shadow Kick','Zephyr Palm','Cloudstep Kick','Dawncrest Kick','Cyclone Barrage','Fists of Fury','Disrupting Palm','Valley Sweep','Mortal Swing','Slicing Winds','Charge','Rend','Gushing Wound','Bladestorm Tick'].includes(label);}
 criticalStrikeChance(c,base=.05){const holyShockTalent=c?.cls==='pala'&&base>.05?unitTalentRank(c,'pala_radiant_shock')*.03:0,cap=base>.05?.95:.35;return c?clamp(base+holyShockTalent+Math.max(0,Number(c?.gearStats?.['Critical Strike']||0))*.00030,0,cap):0;}
 shadowmoonBonusStrength(c){const fragments=c?.has?.('shadowmoonFragments')?.stacks||0;return fragments*SHADOWMOON_FRAGMENT_STRENGTH+(c?.has?.('chaosBaneStrength')?SHADOWMOON_CHAOS_STRENGTH:0);}
 handleShadowmoonProc(c){
  if(this.netGuest||!c?.alive||!c.shadowmoonEquipped||this.time<(c.shadowmoonNextProcAt||0)||Math.random()>=SHADOWMOON_PROC_CHANCE)return;
  c.shadowmoonNextProcAt=this.time+.65;
  let fragment=c.has('shadowmoonFragments');
  if(!fragment)fragment=c.effect('shadowmoonFragments',9999,{stacks:0});
  fragment.stacks=Math.min(10,(fragment.stacks||0)+1);
  this.float(c,`SOUL FRAGMENT ${fragment.stacks}/10`,'info');this.vfxGlyph(c,0x8f48ff,.48);
  if(fragment.stacks<10)return;
  c.effects=c.effects.filter(e=>e!==fragment&&e.type!=='chaosBaneStrength');
  c.effect('chaosBaneStrength',10,{strength:SHADOWMOON_CHAOS_STRENGTH});
  const victims=this.units.filter(u=>u.team!==c.team&&u.alive&&dist(c,u)<=15&&this.arena.los(c,u));
  const split=victims.length?SHADOWMOON_CHAOS_DAMAGE/victims.length:0;
  this.vfxRing(c,0x8e39ff,6.8);this.vfxNova(c,0x6112a8,3.8,28);this.vfxSpiral(c,0xba6cff,1.5);this.float(c,'CHAOS BANE · +120 STRENGTH','info');this.audio.play('proc');
  victims.forEach(target=>{this.damage(c,target,split,'Chaos Bane');this.vfxGlyph(target,0x9b42ff,.72);});
 }
 isReflectableDamage(label){return !this.isMeleeStrike(label)&&!['Skybreaker Pulse','Rend Bleed','Bleed'].includes(label||'')&&!String(label||'').includes('(Reflected)');}
 canSpellReflect(c,t){return !!(t&&t.has('reflect')&&c&&c!==t&&c.team!==t.team);}
 reflectImpact(c,t,label){this.float(t,'SPELL REFLECT!','info');this.float(c,`${String(label||'SPELL').toUpperCase()} REFLECTED`,'error');this.vfxRing(t,0x7fe8ff,2.7);this.vfxGlyph(t,0x8eeaff,.92);this.vfxNova(t,0xbcefff,2.0,16);this.vfxSpiral(c,0x79dfff,.62);this.audio.play('proc');}
 reflectControl(c,t,label,apply){if(!this.canSpellReflect(c,t))return false;this.reflectImpact(c,t,label);apply(c);return true;}
 damage(c,t,v,label){
 if(!t||!t.alive)return false;
 const baseValue=Number(v);
 if(this.canSpellReflect(c,t)&&this.isReflectableDamage(label)){this.reflectImpact(c,t,label);this.damage(t,c,Number.isFinite(baseValue)?baseValue:1,(label||'Spell')+' (Reflected)');return false;}
 let out=Number.isFinite(baseValue)?baseValue:0;
 try{
  if(c&&c.cls==='soul')out*=.67068;/* Soulweaver overall damage reduced by another 10%. */
  if(c&&c.cls==='disc')out*=1.30;/* v197 Discipline damage tuning */
  if(c&&c.cls==='storm')out*=.805;/* v195: 15% buff from the v194 tuned Stormwarden damage level */
  if(c&&c.has&&c.has('darkArchangel'))out*=1.30;if(c&&c.has&&c.has('defensive')?.damagePenalty)out*=1-c.has('defensive').damagePenalty;if(c&&c.has&&c.has('avatar'))out*=1.18;
  if(c&&c.has&&c.has('combustion')&&Math.random()<.80){out*=1.5;this.float(c,'COMBUSTION CRIT','info');}
  if(c&&c.cls==='storm'&&t&&['Arc Spark','Forked Current'].includes(label)){const rod=t.has?.('lightningRod');if(rod&&rod.source===c)out*=1.20;}
  if(c&&c.has&&c.has('totemMastery'))out*=1.03;if(c&&c.has&&c.has('avengingWings'))out*=1+Number(c.has('avengingWings').damageBonus||0);if(c&&c.cls==='shadow'&&label!=='Night Slash')out*=1.10;if(t&&t.has&&t.has('vendetta')&&t.has('vendetta').source===c){/* Vendetta accelerates Shadowblade bleeds/poisons only; no flat damage multiplier. */}
  const oldTigereye=c&&c.has&&c.has('tigereye');
  if(oldTigereye)out*=1+Math.min(10,Number(oldTigereye.stacks||0))*.005;
  const directHit=!this.isPeriodicDamageLabel(label);
  const aftershock=c?.has?.('aftershockPower');if(aftershock&&directHit&&c.cls==='storm'){out*=1+Number(aftershock.pct||0);c.effects=c.effects.filter(e=>e!==aftershock);this.float(c,'AFTERSHOCK EMPOWERED','info');}
  const curseWeaving=c?.has?.('curseWeavingPower');if(curseWeaving&&directHit&&c.cls==='soul'){out*=1+Number(curseWeaving.pct||0);c.effects=c.effects.filter(e=>e!==curseWeaving);this.float(c,'CURSE WEAVING EMPOWERED','info');}
  const overheat=c?.has?.('overheatPower');if(overheat&&label==='Cinder Bolt'){out*=1+Number(overheat.pct||0);c.effects=c.effects.filter(e=>e!==overheat);this.float(c,'OVERHEAT CINDER BOLT','info');}
  if(c&&c.cls){
   const talentMult=Number(classTalentDamageMult(c.cls,c,t,label));
   out*=Number.isFinite(talentMult)&&talentMult>0?talentMult:1;
  }
  if(c&&c.gearStats){
   const primary=(c.gearStats.Intellect||0)+(c.gearStats.Agility||0)+(c.gearStats.Strength||0);
   out*=1+Math.min(.30,(c.gearStats.Power||0)*.00038)+primary*.00014+(c.gearStats.Versatility||0)*.00018;
  }
  // Shadowmoon's temporary Strength is deliberately more concentrated than
  // ordinary permanent gear Strength so the earned ten-fragment surge is
  // visible in actual hit numbers instead of disappearing into rounding.
  const shadowmoonStrength=this.shadowmoonBonusStrength(c);if(shadowmoonStrength)out*=1+shadowmoonStrength*SHADOWMOON_STRENGTH_DAMAGE_PER_POINT;
 }catch(err){
  console.warn('Damage multiplier fallback',label,err);
  out=Number.isFinite(baseValue)?baseValue:1;
 }
 if(!Number.isFinite(out)||out<=0){
  console.warn('Corrected invalid damage value',label,out,'base',baseValue,'caster',c?.cls);
  out=Math.max(1,Number.isFinite(baseValue)?baseValue:1);
 }
 this.enterCombat(c,t);
 if(t.has('iceBlock')){t.takeDamage(c,out,label);return false;}
 const evasion=t.has('evasion');if(evasion&&this.isMeleeStrike(label)&&Math.random()<clamp(Number(evasion.pct??.50),0,1)){this.float(t,'DODGE','info');this.vfxRing(t,0xb27cff,1.25);this.vfxSpiral(t,0xdcc4ff,.45);return false;}
	 const critChance=this.criticalStrikeChance(c),alwaysChaosCrit=/^Chaos Bolt$/i.test(String(label||''));
	 const critical=alwaysChaosCrit||(!/Holy Shock/i.test(String(label||''))&&Math.random()<critChance);
	 if(critical){out*=alwaysChaosCrit?1.5*(1+critChance):1.5;this.float(t,alwaysChaosCrit?'CHAOS CRITICAL!':'CRITICAL STRIKE!','damage');}
 const beforeHp=t.hp;
 t.takeDamage(c,out,label);
 const actual=Math.max(0,beforeHp-t.hp);
 const deathMark=t.effects?.find?.(e=>e.type==='touchOfDeath'&&e.time>0&&e.source===c);
 if(deathMark&&actual>0&&label!=='Touch of Death')deathMark.accumulated=(deathMark.accumulated||0)+actual;
 if(actual>0&&this.isMeleeStrike(label))this.handleShadowmoonProc(c);
 if(label==='Volcanic Eruption'&&actual>0&&c&&t.alive){
  for(let bolt=1;bolt<=2;bolt++){
   this.projectile(c,t,'fire',()=>{
    if(!t.alive)return;
    this.damage(c,t,60,`Volcanic Lava Burst ${bolt}`);
    this.vfxNova(t,bolt===1?0xff8a35:0xffb04a,1.15,9);
    this.vfxGlyph(t,0xffce6b,.42);
   });
  }
 }
 return true;
}  heal(c,t,v,label){
 if(c&&c.gearStats){const primary=(c.gearStats.Intellect||0)+(c.gearStats.Agility||0)+(c.gearStats.Strength||0);v*=1+Math.min(.30,(c.gearStats.Restoration||0)*.00038)+primary*.00014+(c.gearStats.Versatility||0)*.00018;const shadowmoonStrength=this.shadowmoonBonusStrength(c);if(shadowmoonStrength)v*=1+shadowmoonStrength*.00010;}
 if(c&&c.cls)v*=classTalentHealingMult(c.cls,c);
 if(c?.cls==='sage'&&t&&t.hp/t.maxHp<.45)v*=1+unitTalentRank(c,'wildgrowth')*.04;
 if(c?.cls==='sage'&&/Blooming Echo|Rejuvenate|Healing over Time/i.test(String(label||'')))v*=1+unitTalentRank(c,'sage_verdant_tempo')*.03;
 if(c?.cls==='soul'&&/Essence Siphon/i.test(String(label||'')))v*=1+unitTalentRank(c,'drainrite')*.04;
 if(c?.cls==='pala'&&/Holy Shock|Divine Toll|Light of Dawn/i.test(String(label||'')))v*=1+unitTalentRank(c,'radiance')*.04;
 if(c&&['sage','pala','disc'].includes(c.cls))v*=1.15;if(this.mode==='3v3'&&c&&['sage','pala','disc'].includes(c.cls))v*=1.20;if(c&&c.has&&c.has('ghanir')&&['Blooming Echo','Rejuvenate'].includes(label))v*=1.50;if(c&&c.cls==='pala')v*=1.16;if(c&&c.cls==='sage')v*=1.045;if(t&&t.has&&t.has('ironbark'))v*=1.20;if(c&&c.has&&c.has('totemMastery'))v*=1.03;if(c&&c.has('avengingWings'))v*=1.20;if(!/Holy Shock/i.test(String(label||''))&&Math.random()<this.criticalStrikeChance(c)){v*=1.5;this.float(t,'CRITICAL HEAL!','heal');}if(this.isInCombat(t))this.enterCombat(c,t);t.receiveHeal(c,v,label);
}
 supportAttackTarget(u){if(u===this.player)return null;const allies=this.units.filter(a=>a.team===u.team&&a.alive);if(allies.some(a=>a.hp/a.maxHp<.86))return null;return this.units.filter(e=>e.team!==u.team&&e.alive&&!isUntargetableStealth(e,u)&&!e.has('poly')&&!e.has('sleep')&&!e.has('blind')&&!e.has('windIncap')).sort((a,b)=>dist(u,a)-dist(u,b))[0]||null;}
 manualSupportAttack(u,t,show=false){if(!u||!t||!u.alive||!t.alive||t.team===u.team||!['pala','sage'].includes(u.cls))return false;if(u.basicAttackCd>0){if(show)this.message(`${u.cls==='pala'?'Righteous Strike':'Verdant Bolt'} is ready in ${u.basicAttackCd.toFixed(1)}s`);return false;}if(u.cast||u.gcd>0||u.has('iceBlock')||u.has('stun')||u.has('fear')||u.has('poly')||u.has('sleep')||u.has('blind')||u.has('windIncap')){if(show)this.message('You cannot attack right now');return false;}if(!this.arena.los(u,t)){if(show)this.message('Line of sight blocked');return false;}const range=u.cls==='pala'?3.35:24;if(dist(u,t)>range){if(show)this.message(`${u.cls==='pala'?'Righteous Strike':'Verdant Bolt'} requires ${u.cls==='pala'?'melee range':'24m range'}`);return false;}u.basicAttackCd=1;this.enterCombat(u,t);this.animateAction(u,{type:'damage',school:u.cls==='pala'?'holy':'heal'});if(u.cls==='pala'){this.vfxGlyph(t,COLORS.holy,.4);this.vfxBurst(t,COLORS.holy,.34);this.damage(u,t,66,'Righteous Strike');this.audio.play('holy');}else{this.projectile(u,t,'heal',()=>this.damage(u,t,59,'Verdant Bolt'));this.audio.play('heal');}return true;}
 updateSupportAttacks(){for(const u of this.units){if(u===this.player||!u.alive||!['pala','sage'].includes(u.cls))continue;const t=this.supportAttackTarget(u);if(t)this.manualSupportAttack(u,t,false);}}
 vfxEvasion(u,duration=1.5){
  if(!u||!this.scene)return;if(u.evasionFx?.obj)u.evasionFx.obj.dead=true;
  const holder=new THREE.Group(),colours=[0xe9dcff,0xb66cff,0x7040d8,0xffffff],arcs=[];
  for(let i=0;i<4;i++){const material=new THREE.MeshBasicMaterial({color:colours[i],transparent:true,opacity:.72-i*.09,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending}),arc=new THREE.Mesh(new THREE.TorusGeometry(1.05+i*.13,.045+i*.012,7,32,Math.PI*.78),material);arc.rotation.set(Math.PI/2+(i%2)*.38,i*.82,-.55+i*.37);arc.position.y=.72+i*.38;holder.add(arc);arcs.push(arc);}
  const wisps=[];for(let i=0;i<8;i++){const wisp=new THREE.Mesh(new THREE.PlaneGeometry(.08,.72),new THREE.MeshBasicMaterial({color:i%2?0xf5edff:0xa55cff,transparent:true,opacity:.46,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending}));holder.add(wisp);wisps.push(wisp);}
  this.scene.add(holder);let elapsed=0;const fx={obj:holder,life:duration+.08,follow:u,update:dt=>{elapsed+=dt;if(!u.alive||!u.has('evasion')){holder.dead=true;return;}holder.position.set(u.x,0,u.z);holder.rotation.y+=dt*5.4;arcs.forEach((arc,i)=>{arc.rotation.z+=dt*(i%2?4.8:-4.8);arc.material.opacity=.44+Math.sin(elapsed*12+i)*.22;});wisps.forEach((wisp,i)=>{const a=elapsed*(3.8+i*.08)+i*Math.PI/4,r=1.05+(i%3)*.16;wisp.position.set(Math.cos(a)*r,.55+(i%4)*.42,Math.sin(a)*r);wisp.rotation.y=-a;wisp.material.opacity=.24+Math.abs(Math.sin(elapsed*9+i))*.35;});}};u.evasionFx=fx;this.effects.push(fx);
 }
 vfxAlterTimeClock(u,duration=5){
  if(!u||!this.scene)return;if(u.alterTimeFx?.obj)u.alterTimeFx.obj.dead=true;
  const holder=new THREE.Group(),face=new THREE.Group(),gold=new THREE.MeshBasicMaterial({color:0xffd45b,transparent:true,opacity:.92,depthWrite:false,blending:THREE.AdditiveBlending}),soft=new THREE.MeshBasicMaterial({color:0x8b78ff,transparent:true,opacity:.30,side:THREE.DoubleSide,depthWrite:false});
  const aura=new THREE.Mesh(new THREE.RingGeometry(.72,1.05,40),soft);face.add(aura);const rim=new THREE.Mesh(new THREE.TorusGeometry(.86,.07,9,40),gold);face.add(rim);const hand=new THREE.Mesh(new THREE.BoxGeometry(.07,.72,.04),gold.clone());hand.position.y=.24;face.add(hand);const marks=[];for(let i=0;i<12;i++){const mark=new THREE.Mesh(new THREE.BoxGeometry(i%3===0?.09:.055,i%3===0?.24:.15,.035),gold.clone()),a=i/12*Math.PI*2;mark.position.set(Math.sin(a)*.68,Math.cos(a)*.68,0);mark.rotation.z=-a;face.add(mark);marks.push(mark);}holder.add(face);this.scene.add(holder);let elapsed=0;const fx={obj:holder,life:duration+.15,follow:u,update:dt=>{elapsed+=dt;if(!u.alive||!u.has('alterTime')){holder.dead=true;return;}holder.position.set(u.x,3.38+Math.sin(elapsed*5)*.08,u.z);face.quaternion.copy(this.camera.quaternion);hand.rotation.z=-Math.PI*2*(elapsed/duration);const remaining=Math.max(0,duration-elapsed);marks.forEach((mark,i)=>mark.visible=i<Math.ceil(remaining/duration*12));aura.material.opacity=.20+Math.sin(elapsed*7)*.10;}};u.alterTimeFx=fx;this.effects.push(fx);
 }
 vfxShieldWall(u,duration=6){
  if(!u||!this.scene)return;const holder=new THREE.Group(),panels=[];for(let i=0;i<4;i++){const panel=new THREE.Mesh(new THREE.BoxGeometry(.68,1.35,.07),new THREE.MeshBasicMaterial({color:0xb9e7ff,transparent:true,opacity:.48,depthWrite:false,blending:THREE.AdditiveBlending}));const angle=i*Math.PI/2;panel.position.set(Math.cos(angle)*1.18,1.15,Math.sin(angle)*1.18);panel.rotation.y=-angle+Math.PI/2;holder.add(panel);panels.push(panel);}this.scene.add(holder);let elapsed=0;this.effects.push({obj:holder,life:duration,follow:u,update:dt=>{elapsed+=dt;if(!u.alive||!u.has('defensive')){holder.dead=true;return;}holder.position.set(u.x,0,u.z);holder.rotation.y+=dt*.65;panels.forEach((panel,i)=>{panel.material.opacity=.38+Math.sin(elapsed*5+i)*.12;panel.position.y=1.12+Math.sin(elapsed*3+i)*.08;});}});
 }
 vfxAvatarForm(u,duration=10){
  if(!u||!this.scene)return;
  const holder=new THREE.Group();this.scene.add(holder);
  const originals=[];
  u.modelGroup?.traverse?.(node=>{
   if(!node.material)return;
   const previous=node.material,materials=(Array.isArray(previous)?previous:[previous]).map(material=>material?.clone?.()||material);
   node.material=Array.isArray(previous)?materials:materials[0];
   originals.push({node,previous,temporary:materials});
   materials.filter(Boolean).forEach(material=>{
    if(!material.color)return;
    material.color.setHex(0x777b7d);
    if(material.emissive)material.emissive.setHex(0x202326);
    if('roughness'in material)material.roughness=Math.max(.82,Number(material.roughness)||0);
   });
  });
  let restored=false;
  const restore=()=>{if(restored)return;restored=true;originals.forEach(({node,previous,temporary})=>{node.material=previous;temporary.forEach(material=>material!==previous&&material?.dispose?.());});};
  this.effects.push({obj:holder,life:duration+.1,follow:u,update:()=>{if(!u.alive||!u.has('avatar')){restore();holder.dead=true;}}});
 }
 vfxVolcanicEruption(target){if(!target||!this.scene)return;const group=new THREE.Group();const lava=new THREE.MeshStandardMaterial({color:0x5b170d,emissive:0xff4d18,emissiveIntensity:1.5,roughness:.72});const glow=new THREE.MeshBasicMaterial({color:0xff9b35,transparent:true,opacity:.82,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide});const crater=new THREE.Mesh(new THREE.RingGeometry(.55,2.25,42),glow.clone());crater.rotation.x=-Math.PI/2;crater.position.y=.055;group.add(crater);for(let i=0;i<7;i++){const shard=new THREE.Mesh(new THREE.ConeGeometry(.13+(i%3)*.05,.9+(i%4)*.28,6),lava.clone());const a=i/7*Math.PI*2,r=.28+(i%3)*.26;shard.position.set(Math.cos(a)*r,.1,Math.sin(a)*r);shard.rotation.z=(Math.random()-.5)*.35;group.add(shard);}for(let i=0;i<22;i++){const mote=new THREE.Mesh(new THREE.OctahedronGeometry(.045+(i%4)*.018,0),glow.clone());mote.userData.seed=i;group.add(mote);}group.position.set(target.x,0,target.z);this.scene.add(group);let elapsed=0;this.effects.push({obj:group,life:1.15,update:dt=>{elapsed+=dt;group.position.x=target.x;group.position.z=target.z;crater.scale.setScalar(1+elapsed*.55);crater.material.opacity=Math.max(0,.82-elapsed*.58);group.children.slice(1,8).forEach((shard,i)=>{shard.position.y=Math.min(.78+i*.04,shard.position.y+dt*(2.9+i*.17));shard.scale.y=1+Math.sin(elapsed*9+i)*.22;});group.children.slice(8).forEach((mote,i)=>{const a=i*.91+elapsed*(3.5+(i%4)*.3),r=.35+(i%7)*.18;mote.position.set(Math.cos(a)*r,.15+elapsed*(2.1+(i%5)*.35),Math.sin(a)*r);mote.material.opacity=Math.max(0,.9-elapsed*.68);});}});}
 vfxTouchOfDeathMark(target,duration=5){if(!target||!this.scene)return;const holder=new THREE.Group(),face=new THREE.Group();const red=new THREE.MeshBasicMaterial({color:0xff204d,transparent:true,opacity:.92,depthWrite:false,blending:THREE.AdditiveBlending});const dark=new THREE.MeshBasicMaterial({color:0x5b0018,transparent:true,opacity:.38,side:THREE.DoubleSide,depthWrite:false});const ring=new THREE.Mesh(new THREE.TorusGeometry(.62,.065,8,30),red);face.add(ring);const halo=new THREE.Mesh(new THREE.RingGeometry(.72,.96,32),dark);face.add(halo);const blade=new THREE.Mesh(new THREE.ConeGeometry(.23,.90,3),red);blade.rotation.z=Math.PI;blade.position.y=-.05;face.add(blade);const wingL=new THREE.Mesh(new THREE.ConeGeometry(.15,.54,3),red),wingR=wingL.clone();wingL.rotation.z=-1.1;wingR.rotation.z=1.1;wingL.position.set(-.30,.12,0);wingR.position.set(.30,.12,0);face.add(wingL,wingR);holder.add(face);this.scene.add(holder);let elapsed=0;this.effects.push({obj:holder,life:duration,update:dt=>{elapsed+=dt;if(!target.alive){holder.visible=false;return;}holder.position.set(target.x,3.20+Math.sin(elapsed*5)*.10,target.z);face.quaternion.copy(this.camera.quaternion);const pulse=1+Math.sin(elapsed*8)*.08;face.scale.setScalar(pulse);ring.rotation.z+=dt*.75;halo.material.opacity=.20+Math.sin(elapsed*6)*.10;}});}
 vfxWhirlingDragonPunch(c,duration=.85){if(!c||!this.scene)return;const holder=new THREE.Group();holder.position.set(c.x,.08,c.z);const mat=new THREE.MeshBasicMaterial({color:0x67ffb0,transparent:true,opacity:.72,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});const rings=[];for(let i=0;i<5;i++){const ring=new THREE.Mesh(new THREE.TorusGeometry(1.0+i*.23,.055,8,38),mat.clone());ring.rotation.x=Math.PI/2;ring.position.y=i*.38;ring.scale.setScalar(.72+i*.08);holder.add(ring);rings.push(ring);}const motes=[];for(let i=0;i<18;i++){const mote=new THREE.Mesh(new THREE.OctahedronGeometry(.055+(i%3)*.016,0),mat.clone());holder.add(mote);motes.push({mote,seed:i});}this.scene.add(holder);let elapsed=0;this.effects.push({obj:holder,life:duration,update:dt=>{elapsed+=dt;holder.position.x=c.x;holder.position.z=c.z;holder.rotation.y+=dt*7;rings.forEach((ring,i)=>{ring.position.y=.10+i*.38+elapsed*1.05;ring.scale.setScalar(.72+i*.08+elapsed*.38);ring.material.opacity=Math.max(0,.78-elapsed*.70);});motes.forEach(({mote,seed})=>{const a=elapsed*10+seed*.88,r=.55+(seed%6)*.19;mote.position.set(Math.cos(a)*r,.15+elapsed*3.2+(seed%5)*.16,Math.sin(a)*r);mote.rotation.y+=dt*8;mote.material.opacity=Math.max(0,.86-elapsed*.72);});}});}
 dropMeteor(c,x,z){const holder=new THREE.Group();const warning=new THREE.Mesh(new THREE.RingGeometry(.5,5.0,40),new THREE.MeshBasicMaterial({color:0xff5127,transparent:true,opacity:.62,side:THREE.DoubleSide}));warning.rotation.x=-Math.PI/2;warning.position.set(x,.06,z);holder.add(warning);const rock=new THREE.Mesh(new THREE.SphereGeometry(.62,12,10),new THREE.MeshStandardMaterial({color:0x402018,emissive:0xff5522,emissiveIntensity:1.1,roughness:.7}));rock.position.set(x+1.2,16,z-.8);holder.add(rock);const light=new THREE.PointLight(0xff5522,26,17);light.position.copy(rock.position);holder.add(light);this.scene.add(holder);let elapsed=0;this.effects.push({obj:holder,life:1.04,update:dt=>{elapsed+=dt;warning.material.opacity=.32+Math.abs(Math.sin(elapsed*14))*.3;warning.scale.multiplyScalar(1+dt*.22);rock.position.y-=dt*16.2;rock.position.x-=dt*1.2;rock.position.z+=dt*.8;light.position.copy(rock.position);if(elapsed>=.98&&!holder.userData.landed){holder.userData.landed=true;this.vfxRing({x,z},COLORS.fire,7);this.vfxNova({x,z},COLORS.fire,3.5,25);this.vfxGlyph({x,z},0xffb24d,.8);this.audio.play('meteorImpact',{x,z,game:this});this.shake=.24;c.effects=c.effects.filter(e=>e.type!=='meteorLance');c.effect('meteorLance',9999,{stacks:1,pct:.15});c.cds[1]=0;this.float(c,'METEOR LANCE ×1 READY · +15%','info');this.vfxOrbit(c,0xffd067,1.2);this.units.filter(u=>u.team!==c.team&&u.alive&&Math.hypot(u.x-x,u.z-z)<=5.2).forEach(u=>{const hit=this.damage(c,u,205,'Meteorfall');if(hit){u.effect('burn',5,{value:17,source:c});this.float(u,'BURNING','error');}});}}});}
 gainMana(c,amount){if(!c||c.info.resource!=='mana')return;const before=c.resource;c.resource=clamp(c.resource+amount,0,c.maxResource);const gained=Math.round(c.resource-before);if(gained>0&&c===this.player)this.float(c,`+${gained} MANA`,'heal');}
 recordFuryStep(c,step){let seq=c.has('furySequence');if(!seq)seq=c.effect('furySequence',9,{steps:{}});seq.time=9;seq.steps=seq.steps||{};seq.steps[step]=true;if(seq.steps.dawn&&seq.steps.cyclone){c.effects=c.effects.filter(e=>e.type!=='furySequence');c.effect('furyReady',10);c.cds[2]=0;this.float(c,'FISTS OF FURY READY!','info');this.vfxOrbit(c,0xffe39a,1.25);this.audio.play('proc');}}
 applyWindboundSnare(c,target,duration,pct,label){if(!target||!target.alive||target.has('windboundSnareIcd'))return false;target.effect('slow',duration,{pct,source:c,label:'Windbound'});target.effect('windboundSnareIcd',12,{source:c});if(label)this.float(target,label,'info');return true;}
 addFlow(c,target=null){let flow=c.has('flow');if(!flow){flow=c.effect('flow',10,{stacks:1});}else{flow.time=10;flow.stacks=Math.min(3,(flow.stacks||1)+1);}this.vfxKickArc(c,0x72e5a5);if((flow.stacks||1)>=3){c.effects=c.effects.filter(e=>e.type!=='flow');c.effect('tempestFlow',10);if(target&&target.alive&&this.applyWindboundSnare(c,target,3,.50,'WINDBOUND 50%')){this.vfxGlyph(target,COLORS.wind,.72);this.vfxSpiral(target,0x72e5a5,.72);}this.float(c,'TEMPEST FLOW READY!','info');this.vfxOrbit(c,0xffdf79,1.15);this.vfxCyclone(c,COLORS.wind,.55);this.audio.play('proc',c);}}
 addShadowMark(c){let mark=c.has('shadowMarks');if(!mark){mark=c.effect('shadowMarks',9,{stacks:1});}else{mark.time=9;mark.stacks=Math.min(3,(mark.stacks||1)+1);}this.vfxSlash(c,0xa772ff);if((mark.stacks||1)>=3){c.effects=c.effects.filter(e=>e.type!=='shadowMarks');c.effect('venomEdge',10);this.float(c,'VENOM EDGE READY','info');this.vfxOrbit(c,0x8df45b,1.1);this.audio.play('proc');}}
 rollStormSurge(c){let ramp=c.has('stormChance');const chance=Math.min(1,(ramp?.chance||.10)+(c.has('totemMastery')?.05:0));if(Math.random()<chance){const battery=unitTalentRank(c,'storm_arc_battery');c.effects=c.effects.filter(e=>!['stormChance','stormCharge','arcSequence'].includes(e.type));c.effect('tempestBolts',10,{stacks:2});c.effect('overload',10);this.gainMana(c,10+battery);this.float(c,`STORM SURGE! ×2 · +${10+battery} MANA`,'info');this.vfxGlyph(c,COLORS.storm,1.0);this.vfxOrbit(c,0xc1fbff,1.32);this.vfxNova(c,COLORS.storm,2.25,16);this.audio.play('proc');this.log(`${c.name} triggered Storm Surge, restored ${10+battery} mana and readied Volcanic Overload.`);}else{const next=Math.min(1,chance+.10+unitTalentRank(c,'surgeflow')*.01);if(!ramp)ramp=c.effect('stormChance',16,{chance:next,stacks:`${Math.round(next*100)}%`});else{ramp.time=16;ramp.chance=next;ramp.stacks=`${Math.round(next*100)}%`;}if(c===this.player)this.float(c,`SURGE CHANCE ${Math.round(next*100)}%`,'info');}}
 
 volcanicOverload(c,mult=1){const visible=this.units.filter(u=>u.team!==c.team&&u.alive&&this.arena.los(c,u));if(!visible.length)return;this.float(c,`TRIPLE LAVA ×${visible.length}`,'info');this.audio.play('fire');visible.forEach(u=>{[0,1,2].forEach(bolt=>{this.projectile(c,u,'fire',()=>{if(!u.alive)return;this.damage(c,u,45*mult,'Lava Burst');if(bolt===2)u.effect('burn',3,{value:8,source:c});this.vfxNova(u,bolt===0?0xffd069:bolt===1?0xffa447:0xff6435,1.25,8);this.vfxGlyph(u,bolt===0?0xffefd0:bolt===1?0xffce69:0xff8d45,.44);this.float(u,bolt===0?'LAVA I':bolt===1?'LAVA II':'LAVA III','error');});});});this.log(`${c.name}'s Volcanic Overload launched three Lava Bursts at each of ${visible.length} visible enem${visible.length===1?'y':'ies'}.`);}
  plantSpiritBlossom(c,target,dur=9,radius=6,healValue=38,shieldValue=20){const x=target.x,z=target.z;const group=new THREE.Group();const trunkMat=new THREE.MeshStandardMaterial({color:0x5b3e28,roughness:.9});const leafMat=new THREE.MeshStandardMaterial({color:0x45ce83,emissive:0x39df86,emissiveIntensity:.38,roughness:.45});const glowMat=new THREE.MeshBasicMaterial({color:0x83ffb9,transparent:true,opacity:.62,side:THREE.DoubleSide});const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.14,.23,1.6,8),trunkMat);trunk.position.y=.8;group.add(trunk);[[0,1.78,0,.72],[-.46,1.44,.05,.47],[.47,1.48,-.08,.5],[.05,1.48,.45,.44]].forEach(p=>{const crown=new THREE.Mesh(new THREE.SphereGeometry(p[3],10,9),leafMat);crown.position.set(p[0],p[1],p[2]);group.add(crown);});const aura=new THREE.Mesh(new THREE.RingGeometry(radius-.14,radius,48),glowMat);aura.rotation.x=-Math.PI/2;aura.position.y=.06;group.add(aura);const core=new THREE.PointLight(0x72fca8,14,12);core.position.set(0,1.35,0);group.add(core);group.position.set(x,0,z);this.scene.add(group);let tick=.02,time=0;this.float(target,'SPIRIT BLOSSOM','heal');this.vfxNova({x,z},COLORS.heal,2.2,16);this.audio.play('heal');this.effects.push({obj:group,life:dur,update:dt=>{time+=dt;tick-=dt;aura.material.opacity=.36+Math.sin(time*5)*.16;group.children.slice(1,5).forEach((leaf,i)=>leaf.position.y+=(Math.sin(time*3+i)-Math.sin((time-dt)*3+i))*.035);if(tick<=0&&this.phase==='fight'&&!this.paused){tick+=1;const allies=this.units.filter(u=>u.team===c.team&&u.alive&&Math.hypot(u.x-x,u.z-z)<=radius);allies.forEach(u=>{this.heal(c,u,healValue,'Spirit Blossom');const shield=Math.round(shieldValue*(1-this.dampening));u.shield=Math.max(u.shield,shield);u.effect('shield',1.35,{value:shield});c.stats.absorb+=shield;this.float(u,`+${healValue} BLOOM · +${shield} WARD`,'heal');this.vfxRing(u,COLORS.heal,1.08);});this.vfxNova({x,z},COLORS.heal,1.3,8);}}});}
 

 vfxWindlordStrike(c,t){
  if($('#reducedFX').checked||!c||!t)return;
  const group=new THREE.Group(),mats=[0x9a65ff,0xe6d8ff,0xffe277,0x7747ff,0xffffff].map(col=>new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.90,depthWrite:false,blending:THREE.AdditiveBlending}));
  const start=new THREE.Vector3(c.x,1.35,c.z),end=new THREE.Vector3(t.x,1.12,t.z),forward=end.clone().sub(start),len=Math.max(.01,forward.length());forward.normalize();let side=new THREE.Vector3().crossVectors(forward,new THREE.Vector3(0,1,0));if(side.lengthSq()<.001)side.set(1,0,0);side.normalize();
  const streaks=[];
  for(let i=0;i<7;i++){
   const offset=(i-3)*.08,mid=start.clone().lerp(end,.5).add(side.clone().multiplyScalar(offset*3+(i%2?.25:-.25))).add(new THREE.Vector3(0,.45+Math.abs(i-3)*.04,0));
   const curve=new THREE.CatmullRomCurve3([start.clone().add(side.clone().multiplyScalar(offset)),mid,end.clone().add(side.clone().multiplyScalar(offset*.35))]);
   const tube=new THREE.Mesh(new THREE.TubeGeometry(curve,22,.028+(i%3)*.012,7,false),mats[i%mats.length].clone());tube.userData.phase=i*.6;group.add(tube);streaks.push(tube);
  }
  const palm=new THREE.Mesh(new THREE.SphereGeometry(.23,14,10),mats[2].clone());palm.position.copy(start);group.add(palm);
  const impact=new THREE.Mesh(new THREE.OctahedronGeometry(.30),mats[0].clone());impact.position.copy(end);group.add(impact);
  const ring=new THREE.Mesh(new THREE.TorusGeometry(.58,.045,8,42),mats[2].clone());ring.position.copy(end);ring.rotation.x=Math.PI/2;group.add(ring);
  for(let i=0;i<8;i++){const shard=new THREE.Mesh(new THREE.OctahedronGeometry(.045+(i%2)*.018),mats[i%mats.length].clone());const a=i*Math.PI/4;shard.position.copy(end).add(new THREE.Vector3(Math.cos(a)*.48,.05+Math.sin(i)*.15,Math.sin(a)*.48));shard.userData={a};group.add(shard);}
  this.scene.add(group);let time=0;this.effects.push({obj:group,life:.52,update:dt=>{time+=dt;const p=Math.min(1,time/.52);streaks.forEach((s,i)=>{s.material.opacity=Math.max(0,.92-p*(.70+i*.02));s.scale.setScalar(1+p*.12);});palm.scale.setScalar(1+p*1.8);palm.material.opacity=Math.max(0,.72-p);impact.rotation.x+=dt*12;impact.rotation.y+=dt*15;impact.scale.setScalar(1+p*1.7);impact.material.opacity=Math.max(0,.9-p*.9);ring.rotation.z+=dt*8;ring.scale.setScalar(1+p*1.9);ring.material.opacity=Math.max(0,.8-p*.85);group.children.slice(10).forEach((s,i)=>{s.position.x+=Math.cos(s.userData.a)*dt*1.7;s.position.z+=Math.sin(s.userData.a)*dt*1.7;s.position.y+=dt*(.5+i*.03);s.rotation.y+=dt*9;s.material.opacity=Math.max(0,.72-p*.8);});}});
 }
 vfxDisciplineStarBolt(c,t,opts={}){
  if($('#reducedFX').checked||!c||!t)return;
  const healing=!!opts.healing,penance=!!opts.penance,solace=!!opts.solace,bolt=Number(opts.bolt||0);
  const group=new THREE.Group();
  const white=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.96,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});
  const gold=new THREE.MeshBasicMaterial({color:0xffe07a,transparent:true,opacity:.92,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});
  const rainbowMats=[0xfff2a6,0xffffff,0xaee9ff,0xc3a9ff,0x9fffd8].map(col=>new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.82,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending}));
  const start=new THREE.Vector3(c.x,1.48,c.z), end=new THREE.Vector3(t.x,healing?1.18:1.28,t.z);
  const line=end.clone().sub(start); const len=Math.max(.01,line.length()); const dir=line.clone().normalize();
  const up=new THREE.Vector3(0,1,0); let sideVec=new THREE.Vector3().crossVectors(dir,up); if(sideVec.lengthSq()<1e-4)sideVec.set(1,0,0); sideVec.normalize();
  const lift=penance?.10:(solace?.15:.08), arc=penance?.08:(solace?.28:.14), lateral=(bolt%2?1:-1)*(penance?.18:(solace?.24:.12));
  const control=start.clone().lerp(end,.5).add(sideVec.clone().multiplyScalar(lateral)).add(new THREE.Vector3(0,arc,0));
  const beamCount=penance?5:(solace?3:4), beamMeshes=[];
  for(let i=0;i<beamCount;i++){
    const radius=penance?.040:(solace?.055:.05);
    const tube=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,1,10,1,true),(i%2?white:gold).clone());
    beamMeshes.push(tube); group.add(tube);
  }
  const head=new THREE.Mesh(new THREE.OctahedronGeometry(penance?.11:(solace?.16:.13)),white.clone()); group.add(head);
  const halo=new THREE.Mesh(new THREE.TorusGeometry(penance?.16:(solace?.22:.18),.024,8,28),(solace?white:gold).clone()); halo.rotation.x=Math.PI/2; group.add(halo);
  const trail=[]; const trailCount=penance?14:(solace?18:11);
  for(let i=0;i<trailCount;i++){const m=solace?rainbowMats[i%rainbowMats.length].clone():(i%2?gold.clone():white.clone()); const s=new THREE.Mesh(new THREE.OctahedronGeometry(solace?.03+(i%3)*.008:.028+(i%2)*.008),m); s.visible=false; group.add(s); trail.push(s);} 
  if(penance){for(let i=0;i<3;i++){const arcMesh=new THREE.Mesh(new THREE.TorusGeometry(.70+i*.16,.045,8,42,Math.PI*1.15),(i%2?white:gold).clone()); arcMesh.rotation.x=Math.PI/2; arcMesh.rotation.z=-1.65+i*.22; arcMesh.userData.arc=true; group.add(arcMesh);}}
  this.scene.add(group);
  let elapsed=0; const duration=penance?.26:(solace?.46:.34), history=[];
  const bezier=(p)=>{const q=1-p; return new THREE.Vector3(q*q*start.x+2*q*p*control.x+p*p*end.x,q*q*start.y+2*q*p*control.y+p*p*end.y,q*q*start.z+2*q*p*control.z+p*p*end.z);};
  this.effects.push({obj:group,life:duration+.20,update:dt=>{
    elapsed+=dt; const p=Math.min(1,elapsed/duration); const pos=bezier(p); const prev=bezier(Math.max(0,p-.02)); const tangent=pos.clone().sub(prev); const segLen=Math.max(.001,tangent.length()); tangent.normalize();
    group.position.copy(pos); head.rotation.x+=dt*9; head.rotation.y+=dt*12; halo.rotation.z+=dt*(solace?7:11);
    beamMeshes.forEach((tube,i)=>{const frac=(i+1)/(beamMeshes.length+1), bp=bezier(Math.max(0,p-frac*.08)); const before=bezier(Math.max(0,p-frac*.08-.02)); const dirSeg=bp.clone().sub(before); const localLen=Math.max(.001,dirSeg.length()); dirSeg.normalize(); tube.position.copy(bp.clone().sub(pos)); tube.scale.set(1,Math.max(.5,(len/beamMeshes.length)*(penance?1.15:1.35)),1); tube.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),dirSeg); tube.material.opacity=Math.max(0,.15+.72*(1-frac)*(1-p*.15)); if(solace)tube.material.color.set([0xfff0a4,0xffffff,0x9ddfff][i%3]);});
    history.unshift(pos.clone()); if(history.length>trail.length)history.pop();
    trail.forEach((s,i)=>{const h=history[Math.min(i,history.length-1)]; if(!h)return; s.visible=true; s.position.copy(h).sub(pos); const scale=solace?Math.max(.22,1-i/trail.length):Math.max(.16,1-i/trail.length); s.scale.setScalar(scale); s.material.opacity=(solace?.82:.70)*(1-i/trail.length); s.rotation.y+=dt*(5+i*.3);});
    if(penance){group.children.filter(x=>x.userData.arc).forEach((arcMesh,i)=>{arcMesh.material.opacity=Math.max(0,.55-p*.9); arcMesh.rotation.y+=dt*(5.5+i); arcMesh.scale.multiplyScalar(1+dt*1.8);});}
    if(p>=1)group.scale.multiplyScalar(.86);
  }});
 }
 vfxPainSuppression(u,dur=5){
  if($('#reducedFX').checked||!u)return;
  const group=new THREE.Group();
  const wingMat=new THREE.MeshBasicMaterial({color:0xf4f0ff,transparent:true,opacity:.74,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});
  const sigilMat=new THREE.MeshBasicMaterial({color:0xffefab,transparent:true,opacity:.70,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});
  const dome=new THREE.Mesh(new THREE.SphereGeometry(1.08,18,12,0,Math.PI*2,0,Math.PI/2),new THREE.MeshBasicMaterial({color:0xded7ff,transparent:true,opacity:.14,wireframe:true,depthWrite:false,blending:THREE.AdditiveBlending})); dome.position.y=.02; group.add(dome);
  const ring=new THREE.Mesh(new THREE.TorusGeometry(.92,.028,8,48),sigilMat.clone()); ring.rotation.x=Math.PI/2; ring.position.y=.14; group.add(ring);
  const halo=new THREE.Mesh(new THREE.RingGeometry(.44,.52,28),sigilMat.clone()); halo.rotation.x=Math.PI/2; halo.position.y=2.02; group.add(halo);
  for(let side of [-1,1]){for(let i=0;i<4;i++){const feather=new THREE.Mesh(new THREE.PlaneGeometry(.26-.02*i,.60-.05*i),wingMat.clone()); feather.position.set(side*(.55+.11*i),1.38-.04*i,0); feather.rotation.z=side*(.95+i*.16); group.add(feather);}}
  for(let i=0;i<6;i++){const star=new THREE.Mesh(new THREE.OctahedronGeometry(.045+.01*(i%2)),sigilMat.clone()); star.userData.phase=i*Math.PI*2/6; group.add(star);} 
  this.scene.add(group); let time=0; this.effects.push({obj:group,life:dur,follow:u,update:dt=>{time+=dt; group.position.set(u.x,0,u.z); dome.scale.setScalar(1+.04*Math.sin(time*7)); dome.material.opacity=.12+.05*Math.sin(time*6); ring.rotation.z+=dt*2.4; halo.rotation.z-=dt*1.8; group.children.slice(3,11).forEach((f,i)=>{f.material.opacity=.46+.16*Math.sin(time*4+i*.5);}); group.children.slice(11).forEach((star,i)=>{const a=time*2.8+star.userData.phase; star.position.set(Math.cos(a)*.78,1.05+.48*Math.sin(time*2+i),Math.sin(a)*.78); star.rotation.y+=dt*5; star.material.opacity=.48+.2*Math.sin(time*5+i);});}});
 }
 vfxBladestormChannel(u,dur=4){
 if($('#reducedFX').checked)return;
 const group=new THREE.Group(),gold=new THREE.MeshBasicMaterial({color:0xffd36b,transparent:true,opacity:.82,depthWrite:false,blending:THREE.AdditiveBlending}),red=new THREE.MeshBasicMaterial({color:0xff4938,transparent:true,opacity:.65,depthWrite:false,blending:THREE.AdditiveBlending});
 for(let i=0;i<4;i++){const ring=new THREE.Mesh(new THREE.TorusGeometry(1.0+i*.34,.055,8,64),i%2?red:gold);ring.rotation.x=Math.PI/2;ring.position.y=.18+i*.12;ring.userData.speed=(i%2?1:-1)*(5.5+i);group.add(ring);}
 for(let i=0;i<8;i++){const blade=new THREE.Mesh(new THREE.BoxGeometry(.08,.05,1.25),i%2?red:gold);blade.position.y=.72;blade.rotation.y=i*Math.PI/4;blade.userData.phase=i*Math.PI/4;group.add(blade);}
 this.scene.add(group);let time=0;const fx={obj:group,life:dur,follow:u,update:dt=>{time+=dt;if(!u.alive||!u.has('bladestorm')){fx.dead=true;return;}group.position.set(u.x,0,u.z);group.children.slice(0,4).forEach((r,i)=>r.rotation.z+=dt*r.userData.speed);group.children.slice(4).forEach((b,i)=>{const a=time*10+b.userData.phase;b.position.set(Math.cos(a)*1.25,.78+.12*Math.sin(time*7+i),Math.sin(a)*1.25);b.rotation.y=-a;b.material.opacity=.48+.30*Math.sin(time*9+i);});}};u.bladestormFx=fx;this.effects.push(fx);
}
vfxUndyingResolve(u,dur=5){
 if($('#reducedFX').checked)return;
 const group=new THREE.Group(),voidMat=new THREE.MeshBasicMaterial({color:0x8e35ff,transparent:true,opacity:.74,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending}),darkMat=new THREE.MeshBasicMaterial({color:0x2c073f,transparent:true,opacity:.82,side:THREE.DoubleSide,depthWrite:false});
 for(let i=0;i<6;i++){const plate=new THREE.Mesh(new THREE.BoxGeometry(.34,1.15,.09),darkMat);const a=i*Math.PI/3;plate.position.set(Math.cos(a)*.78,.72,Math.sin(a)*.78);plate.rotation.y=-a;group.add(plate);}
 const dome=new THREE.Mesh(new THREE.SphereGeometry(1.05,18,12,0,Math.PI*2,0,Math.PI/2),voidMat);dome.position.y=.05;group.add(dome);
 const crown=new THREE.Mesh(new THREE.TorusGeometry(.88,.045,8,48),voidMat);crown.rotation.x=Math.PI/2;crown.position.y=1.55;group.add(crown);
 for(let i=0;i<5;i++){const rune=new THREE.Mesh(new THREE.OctahedronGeometry(.10),voidMat);rune.userData.phase=i*Math.PI*2/5;group.add(rune);}
 this.scene.add(group);let time=0;this.effects.push({obj:group,life:dur,follow:u,update:dt=>{time+=dt;group.position.set(u.x,0,u.z);dome.scale.setScalar(1+.07*Math.sin(time*6));crown.rotation.z+=dt*4.6;group.children.slice(8).forEach((r,i)=>{const a=time*3+r.userData.phase;r.position.set(Math.cos(a)*1.12,.95+.35*Math.sin(time*2+i),Math.sin(a)*1.12);r.rotation.y+=dt*6;});voidMat.opacity=.58+.22*Math.sin(time*7);}});
}
vfxRisingSunKick(c,t){
 if($('#reducedFX').checked)return;
 const group=new THREE.Group(),gold=new THREE.MeshBasicMaterial({color:0xffd966,transparent:true,opacity:.92,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending}),white=new THREE.MeshBasicMaterial({color:0xfff6c7,transparent:true,opacity:.88,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});
 for(let i=0;i<5;i++){const arc=new THREE.Mesh(new THREE.TorusGeometry(1.05+i*.20,.075,8,48,Math.PI*1.35),i%2?white:gold);arc.rotation.x=Math.PI/2;arc.rotation.z=-1.8+i*.18;arc.position.y=.55+i*.12;group.add(arc);}
 this.scene.add(group);let life=.46;group.position.set(t.x,0,t.z);this.effects.push({obj:group,life,update:dt=>{group.rotation.y+=dt*9;group.scale.multiplyScalar(1+dt*2.7);group.children.forEach((m,i)=>m.material.opacity=Math.max(0,m.material.opacity-dt*(1.7+i*.08)));}});
 this.vfxNova(t,0xffd966,1.65,14);this.vfxKickArc(t,0xffec96);
}
vfxGhanir(u,dur=7){
 if($('#reducedFX').checked)return;
 const group=new THREE.Group(),green=new THREE.MeshBasicMaterial({color:0x65ff9c,transparent:true,opacity:.70,depthWrite:false,blending:THREE.AdditiveBlending}),gold=new THREE.MeshBasicMaterial({color:0xffe68a,transparent:true,opacity:.72,depthWrite:false,blending:THREE.AdditiveBlending});
 const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.08,.16,1.45,8),gold);trunk.position.y=.72;group.add(trunk);
 for(let i=0;i<12;i++){const leaf=new THREE.Mesh(new THREE.ConeGeometry(.07,.28,6),i%3?green:gold);leaf.userData.phase=i*Math.PI*2/12;group.add(leaf);}
 const ring=new THREE.Mesh(new THREE.TorusGeometry(1.15,.035,8,52),green);ring.rotation.x=Math.PI/2;ring.position.y=.08;group.add(ring);this.scene.add(group);let time=0;this.effects.push({obj:group,life:dur,follow:u,update:dt=>{time+=dt;group.position.set(u.x,0,u.z);ring.rotation.z+=dt*2.8;group.children.slice(1,13).forEach((leaf,i)=>{const a=time*2.2+leaf.userData.phase;leaf.position.set(Math.cos(a)*(.72+.12*Math.sin(time+i)),.75+.45*Math.sin(time*1.8+i),Math.sin(a)*(.72+.12*Math.sin(time+i)));leaf.rotation.y=-a;leaf.material.opacity=.48+.28*Math.sin(time*5+i);});}});
}
vfxIronbark(u,dur=6){if($('#reducedFX').checked)return;const group=new THREE.Group();const barkMat=new THREE.MeshBasicMaterial({color:0x6f4a28,transparent:true,opacity:.62,side:THREE.DoubleSide,depthWrite:false});const leafMat=new THREE.MeshBasicMaterial({color:0x7cff9d,transparent:true,opacity:.78,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});for(let i=0;i<7;i++){const slab=new THREE.Mesh(new THREE.BoxGeometry(.16,.86,.055),barkMat);const a=i*Math.PI*2/7;slab.position.set(Math.cos(a)*.68,.62,Math.sin(a)*.68);slab.rotation.y=-a;group.add(slab);}const ring=new THREE.Mesh(new THREE.TorusGeometry(.82,.022,7,42),leafMat);ring.rotation.x=Math.PI/2;ring.position.y=.12;group.add(ring);for(let i=0;i<10;i++){const leaf=new THREE.Mesh(new THREE.ConeGeometry(.035,.18,5),leafMat);leaf.userData.phase=i*.6;group.add(leaf);}this.scene.add(group);let time=0;this.effects.push({obj:group,life:dur,follow:u,update:dt=>{time+=dt;group.position.set(u.x,0,u.z);ring.rotation.z+=dt*2.4;group.children.slice(8).forEach((leaf,i)=>{const a=time*(1.9+i*.03)+i*Math.PI/5;leaf.position.set(Math.cos(a)*(.86+.06*Math.sin(time+i)),.75+.32*Math.sin(time*2+i),Math.sin(a)*(.86+.06*Math.sin(time+i)));leaf.rotation.z=-a;leaf.material.opacity=.52+.26*Math.sin(time*4+i);});barkMat.opacity=.42+.14*Math.sin(time*5);}});}
  applyShield(c,t,v,dur){if(c?.has?.('totemMastery'))v*=1.05;if(c?.cls==='soul')v*=1+unitTalentRank(c,'soul_barrier_rites')*.03;if(c?.cls==='pala')v*=1+unitTalentRank(c,'guardianlight')*.04;v=Math.round(v*(1-this.dampening));t.shield=Math.max(t.shield,v);t.effect('shield',dur,{value:v});c.stats.absorb+=v;this.float(t,`+${v} WARD`,'heal');this.shieldBubble(t,COLORS.shield,dur);}
 applyCC(t,type,duration,label,category){if(t.has('iceBlock')||(t.has('freedom')&&['root','slow'].includes(type))){this.float(t,'IMMUNE','info');return false;}if(t.has('bladestorm')&&['stun','furyStun','root','slow'].includes(type)){this.float(t,'BLADESTORM IMMUNE','info');return false;}let now=this.time,dr=t.dr[category];if(now>dr.until){dr.level=0;}if(dr.level>=3){this.float(t,'IMMUNE','info');return false;}const scales=[1,.5,.25];duration*=scales[dr.level];dr.level++;dr.until=now+BALANCE.ccDRReset;if((type==='stun'||type==='furyStun'||type==='fear'||type==='poly'||type==='sleep'||type==='gouge'||type==='blind'||type==='windIncap')&&t.cast)t.cast=null;t.effect(type,duration);this.float(t,`${label} ${duration.toFixed(1)}s`,'info');return true;}
 applyStun(t,duration){this.applyCC(t,'stun',duration,'STUN','stun');}
 applyFear(t,duration){this.applyCC(t,'fear',duration,'FEAR','fear');}
 applyPoly(t,duration){this.applyCC(t,'poly',duration,'POLY','incap');}
 applySleep(t,duration){this.applyCC(t,'sleep',duration,'SLUMBER','incap');}
 applyBlind(t,duration){this.applyCC(t,'blind',duration,'BLIND','disorient');}
 applyGouge(t,duration){this.applyCC(t,'gouge',duration,'GOUGE','incap');}
 applyWindIncap(t,duration){this.applyCC(t,'windIncap',duration,'INCAPACITATE','incap');}
 applyRoot(t,duration){return this.applyCC(t,'root',duration,'ROOT','root');}  applySnareDR(t,duration,pct,label='SNARE'){const ok=this.applyCC(t,'slow',duration,label,'root');if(ok){const e=t.has('slow');if(e)e.pct=pct;}return ok;}
 isPeriodicDamageLabel(label){const s=String(label||'').toLowerCase();return ['burn','poison','bleed','rend','garrote','internal bleeding','soul scar','creeping torment','unstable affliction','living bomb','flame shock','ember trail','karma','fire shield burn'].some(x=>s.includes(x));}
 breakControl(t,type,label){const e=t.has(type);if(!e)return;t.effects=t.effects.filter(x=>x!==e);this.float(t,label,'error');this.log(`${t.name}: ${label}.`);}
 dash(c,len,back=false,forwardWhenIdle=false){let v=c===this.player?this.movementVector():{x:0,z:0},dx=v.x,dz=v.z;if(!dx&&!dz){if(c===this.player&&forwardWhenIdle){dx=-Math.sin(this.cameraRig.yaw);dz=-Math.cos(this.cameraRig.yaw);}else{const e=this.closestEnemy(c);if(e){dx=c.x-e.x;dz=c.z-e.z;if(back){dx=-dx;dz=-dz;}}else{dx=-Math.sin(this.cameraRig.yaw);dz=-Math.cos(this.cameraRig.yaw);}}}let l=Math.hypot(dx,dz)||1;c.x+=dx/l*len;c.z+=dz/l*len;this.arena.constrain(c);this.vfxTrail(c,c.cls==='flame'?COLORS.fire:COLORS.storm);}
 moveAdjacent(c,t,smooth=false){let sx=c.x,sz=c.z,dx=c.x-t.x,dz=c.z-t.z,l=Math.hypot(dx,dz)||1;c.x=t.x+dx/l*2.5;c.z=t.z+dz/l*2.5;this.arena.constrain(c);if(smooth){const duration=.34;c.dashTween={from:{x:sx,z:sz},to:{x:c.x,z:c.z},left:duration,total:duration};}}
 projectile(c,t,school,onHit){let col=school==='fire'?COLORS.fire:school==='storm'?COLORS.storm:school==='stormbolt'?0x9c63ff:school==='heal'?COLORS.heal:school==='holy'?COLORS.holy:school==='arcane'?0xe0c2ff:COLORS.shadow;const m=new THREE.Mesh(new THREE.SphereGeometry(school==='stormbolt'?.23:.17,8,8),new THREE.MeshBasicMaterial({color:col}));m.position.set(c.x,1.3,c.z);this.scene.add(m);this.effects.push({obj:m,life:1.1,update:dt=>{if(!t.alive){m.dead=true;return;}if(!this.arena.los({x:m.position.x,z:m.position.z},t)){m.dead=true;this.vfxBurst({x:m.position.x,z:m.position.z},0xe15a3c,.48);if(c===this.player)this.message('LINE OF SIGHT — projectile blocked');this.float(t,'BLOCKED','error');return;}let dx=t.x-m.position.x,dz=t.z-m.position.z,l=Math.hypot(dx,dz);if(l<.45){m.dead=true;if(t.has('iceBlock')&&t.team!==c.team){this.float(t,'IMMUNE','info');return;}onHit();this.vfxBurst(t,col,.55);return;}m.position.x+=dx/l*(school==='stormbolt'?28:34)*dt;m.position.z+=dz/l*(school==='stormbolt'?28:34)*dt;}});}
 lightning(a,b){const mat=new THREE.LineBasicMaterial({color:COLORS.storm,transparent:true,opacity:1});const pts=[];for(let i=0;i<=7;i++){let q=i/7;pts.push(new THREE.Vector3(lerp(a.x,b.x,q)+(i>0&&i<7?(Math.random()-.5)*.42:0),1.35+(Math.random()-.5)*.15,lerp(a.z,b.z,q)+(i>0&&i<7?(Math.random()-.5)*.42:0)));}const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),mat);this.scene.add(line);this.effects.push({obj:line,life:.18,update:dt=>mat.opacity-=dt*5.5});this.vfxBurst(b,COLORS.storm,.5);}
 fxAllowed(weight=1){const bucket=Math.floor(performance.now()/250);if(this.fxBucket!==bucket){this.fxBucket=bucket;this.fxSpent=0;}const budget=this.mode==='3v3'?48:90;if((this.fxSpent||0)+weight>budget)return false;this.fxSpent=(this.fxSpent||0)+weight;return true;}
 vfxBurst(u,col,size){if($('#reducedFX').checked||!this.fxAllowed(2))return;const mesh=new THREE.Mesh(new THREE.SphereGeometry(size,12,10),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.5,wireframe:true}));mesh.position.set(u.x,1,u.z);this.scene.add(mesh);this.effects.push({obj:mesh,life:.38,update:dt=>{mesh.scale.multiplyScalar(1+dt*4.5);mesh.material.opacity-=dt*1.7;}});this.vfxNova(u,col,size*1.45,6);}
 vfxReflectWard(u,dur=2.5){if($('#reducedFX').checked)return;const group=new THREE.Group();const shell=new THREE.Mesh(new THREE.SphereGeometry(1.18,16,12),new THREE.MeshBasicMaterial({color:0x70dcff,transparent:true,opacity:.12,wireframe:true,depthWrite:false,blending:THREE.AdditiveBlending}));group.add(shell);const mat=new THREE.MeshBasicMaterial({color:0xb9f3ff,transparent:true,opacity:.74,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});const wardA=new THREE.Mesh(new THREE.RingGeometry(.82,.9,6),mat.clone());wardA.rotation.x=Math.PI/2;group.add(wardA);const wardB=new THREE.Mesh(new THREE.RingGeometry(1.02,1.08,6),mat.clone());wardB.rotation.y=Math.PI/2;group.add(wardB);const crest=new THREE.Mesh(new THREE.OctahedronGeometry(.16),new THREE.MeshBasicMaterial({color:0xe0fbff,transparent:true,opacity:.9}));crest.position.y=1.48;group.add(crest);group.position.set(u.x,1.05,u.z);this.scene.add(group);let elapsed=0;this.effects.push({obj:group,life:dur,update:dt=>{elapsed+=dt;group.position.set(u.x,1.05,u.z);group.rotation.y+=dt*3.5;wardA.rotation.z+=dt*4.2;wardB.rotation.z-=dt*3.2;const pulse=1+.05*Math.sin(elapsed*12);shell.scale.setScalar(pulse);shell.material.opacity=.10+.055*Math.sin(elapsed*12);crest.rotation.y+=dt*6;}});}
  vfxNova(u,col,size=1.6,count=10){if($('#reducedFX').checked||!this.fxAllowed(Math.max(1,Math.ceil(count/5))))return;const n=Math.max(1,count|0),positions=new Float32Array(n*3),velocity=new Float32Array(n*3);for(let i=0;i<n;i++){const ang=(i/n)*Math.PI*2+Math.random()*.25,speed=size*(1.5+Math.random()*.9);positions[i*3]=u.x;positions[i*3+1]=1+Math.random()*.75;positions[i*3+2]=u.z;velocity[i*3]=Math.cos(ang)*speed;velocity[i*3+1]=.7+Math.random()*.24;velocity[i*3+2]=Math.sin(ang)*speed;}const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));const points=new THREE.Points(geo,new THREE.PointsMaterial({color:col,size:.11,transparent:true,opacity:.88,depthWrite:false,blending:THREE.AdditiveBlending,sizeAttenuation:true}));this.scene.add(points);let age=0;this.effects.push({obj:points,life:.52,update:dt=>{age+=dt;for(let i=0;i<n;i++){positions[i*3]+=velocity[i*3]*dt;positions[i*3+1]+=velocity[i*3+1]*dt;positions[i*3+2]+=velocity[i*3+2]*dt;}geo.attributes.position.needsUpdate=true;points.material.opacity=Math.max(0,.88-age*1.72);}});}
 vfxRing(u,col,max){const mesh=new THREE.Mesh(new THREE.RingGeometry(.3,.39,32),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.8,side:THREE.DoubleSide}));mesh.rotation.x=-Math.PI/2;mesh.position.set(u.x,.08,u.z);this.scene.add(mesh);this.effects.push({obj:mesh,life:.5,update:dt=>{let s=1+dt*max*5;mesh.scale.multiplyScalar(s);mesh.material.opacity-=dt*1.6;}});}
 vfxGlyph(u,col,dur=.85){if($('#reducedFX').checked)return;const group=new THREE.Group();const mat=new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.8,side:THREE.DoubleSide});for(let i=0;i<3;i++){const r=new THREE.Mesh(new THREE.RingGeometry(.5+i*.18,.53+i*.18,6),mat.clone());r.rotation.x=-Math.PI/2;r.rotation.z=i*.42;group.add(r);}group.position.set(u.x,.12,u.z);this.scene.add(group);this.effects.push({obj:group,life:dur,update:dt=>{group.rotation.y+=dt*5;group.scale.multiplyScalar(1+dt*.34);group.children.forEach(c=>c.material.opacity-=dt*.75);}});}
 vfxAfflictionApply(u,col,variant='scar'){if($('#reducedFX').checked)return;const group=new THREE.Group();const runeCol=variant==='unstable'?0xf594ff:variant==='torment'?0xda81ff:col;for(let i=0;i<3;i++){const rune=new THREE.Mesh(new THREE.RingGeometry(.34+i*.17,.37+i*.17,variant==='unstable'?7:6),new THREE.MeshBasicMaterial({color:runeCol,transparent:true,opacity:.9,side:THREE.DoubleSide}));rune.rotation.x=-Math.PI/2;rune.rotation.z=i*.47;group.add(rune);}const core=new THREE.Mesh(new THREE.SphereGeometry(.13,8,7),new THREE.MeshStandardMaterial({color:0xf2caff,emissive:runeCol,emissiveIntensity:1,transparent:true,opacity:.92}));core.position.y=1.2;group.add(core);group.position.set(u.x,.12,u.z);this.scene.add(group);let time=0;this.effects.push({obj:group,life:.72,follow:u,update:dt=>{time+=dt;group.position.set(u.x,.12,u.z);group.rotation.y+=dt*5;group.children.slice(0,3).forEach((r,i)=>{r.rotation.z+=dt*(i%2?5:-5);r.scale.multiplyScalar(1+dt*(.25+i*.12));r.material.opacity-=dt*1.12;});core.position.y=1.2+time*1.55;core.material.opacity-=dt*1.1;}});this.vfxNova(u,runeCol,1.4,variant==='unstable'?11:7);}
 vfxSiphonChannel(c,t,dur=2.5){if($('#reducedFX').checked)return;const group=new THREE.Group();const casterRing=new THREE.Mesh(new THREE.RingGeometry(.62,.78,30),new THREE.MeshBasicMaterial({color:0xb85cff,transparent:true,opacity:.84,side:THREE.DoubleSide}));casterRing.rotation.x=-Math.PI/2;group.add(casterRing);const targetRing=new THREE.Mesh(new THREE.RingGeometry(.54,.7,30),new THREE.MeshBasicMaterial({color:0xe597ff,transparent:true,opacity:.82,side:THREE.DoubleSide}));targetRing.rotation.x=-Math.PI/2;group.add(targetRing);const tetherMat=new THREE.LineBasicMaterial({color:0xd68aff,transparent:true,opacity:.72});const points=[new THREE.Vector3(),new THREE.Vector3()];const tether=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),tetherMat);group.add(tether);for(let i=0;i<5;i++){const mote=new THREE.Mesh(new THREE.SphereGeometry(.07,7,6),new THREE.MeshBasicMaterial({color:i%2?0xf1c7ff:0xb85cff,transparent:true,opacity:.9}));group.add(mote);}this.scene.add(group);let time=0;this.effects.push({obj:group,life:dur,update:dt=>{time+=dt;if(!c.alive||!t.alive||!c.cast||!c.cast.soulDrain){group.userData.dead=true;return;}casterRing.position.set(c.x,.1,c.z);targetRing.position.set(t.x,.1,t.z);casterRing.rotation.z+=dt*3.2;targetRing.rotation.z-=dt*4.1;casterRing.material.opacity=.55+Math.sin(time*12)*.22;targetRing.material.opacity=.52+Math.sin(time*12+1)*.2;const start=new THREE.Vector3(c.x,1.35,c.z),end=new THREE.Vector3(t.x,1.2,t.z);tether.geometry.setFromPoints([start,end]);group.children.slice(3).forEach((m,i)=>{const p=((time*1.55+i*.19)%1);m.position.lerpVectors(end,start,p);m.position.y+=Math.sin(time*12+i)*.06;m.material.opacity=.45+Math.sin(time*10+i)*.25;});}});}
 vfxSiphonPulse(c,t,power){if($('#reducedFX').checked)return;const orb=new THREE.Mesh(new THREE.SphereGeometry(.14+.025*power,8,7),new THREE.MeshBasicMaterial({color:0xf2d2ff,transparent:true,opacity:.95}));orb.position.set(t.x,1.25,t.z);this.scene.add(orb);let p=0;this.effects.push({obj:orb,life:.42,update:dt=>{p=Math.min(1,p+dt*2.65);orb.position.set(lerp(t.x,c.x,p),lerp(1.25,1.42,p)+Math.sin(p*Math.PI)*.33,lerp(t.z,c.z,p));orb.scale.setScalar(1+p*.5);orb.material.opacity=1-p*.88;}});this.vfxBurst(t,0xba62ff,.52);}
  vfxSpiral(u,col,dur=.85){if($('#reducedFX').checked||!this.fxAllowed(2))return;const group=new THREE.Group();for(let i=0;i<8;i++){const mote=new THREE.Mesh(new THREE.SphereGeometry(.05,6,6),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.9}));group.add(mote);}this.scene.add(group);let time=0;this.effects.push({obj:group,life:dur,update:dt=>{time+=dt;group.children.forEach((m,i)=>{const a=time*6+i*Math.PI/4;const rad=.55-(time/dur)*.18;m.position.set(u.x+Math.cos(a)*rad,1+time*1.45+i*.08,u.z+Math.sin(a)*rad);m.material.opacity-=dt*.85;});}});}
 vfxOrbit(u,col,dur=.8){if($('#reducedFX').checked||!this.fxAllowed(2))return;const group=new THREE.Group();for(let i=0;i<6;i++){const m=new THREE.Mesh(new THREE.SphereGeometry(.065,6,6),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.9}));group.add(m);}this.scene.add(group);let time=0;this.effects.push({obj:group,life:dur,follow:u,update:dt=>{time+=dt;group.children.forEach((m,i)=>{const a=time*9+i*Math.PI/3;m.position.set(u.x+Math.cos(a)*.8,1.25+Math.sin(a*2)*.18,u.z+Math.sin(a)*.8);m.material.opacity-=dt*.6;});}});}
 vfxFistsChannel(u,dur=2.5){if($('#reducedFX').checked)return;const group=new THREE.Group();const outer=new THREE.Mesh(new THREE.RingGeometry(4.78,4.98,46),new THREE.MeshBasicMaterial({color:0x72e5a5,transparent:true,opacity:.34,side:THREE.DoubleSide}));outer.rotation.x=-Math.PI/2;outer.position.y=.07;group.add(outer);for(let i=0;i<4;i++){const fist=new THREE.Mesh(new THREE.TorusGeometry(.42,.05,6,18,Math.PI*.68),new THREE.MeshBasicMaterial({color:i%2?0xffdf79:0x72e5a5,transparent:true,opacity:.8}));fist.rotation.x=Math.PI/2;fist.position.y=.8+i*.22;group.add(fist);}this.scene.add(group);let time=0;const fx={obj:group,life:dur,follow:u,update:dt=>{time+=dt;if(!u.alive||u.cast?.a?.type!=='fistsChannel'){fx.dead=true;return;}group.position.set(u.x,0,u.z);outer.rotation.z+=dt*3.2;outer.material.opacity=.20+Math.sin(time*12)*.10;group.children.slice(1).forEach((m,i)=>{const a=time*(10+i*.9)+i*Math.PI/2;m.position.x=Math.cos(a)*(1.0+i*.18);m.position.z=Math.sin(a)*(1.0+i*.18);m.rotation.z+=dt*(13+i);m.material.opacity=.52+Math.sin(a)*.25;});}};u.fistsFx=fx;this.effects.push(fx);}
 vfxFuryPulse(u,radius,tick){if($('#reducedFX').checked)return;const ring=new THREE.Mesh(new THREE.RingGeometry(.45,.62,34),new THREE.MeshBasicMaterial({color:tick%2?0xffdf79:0x72e5a5,transparent:true,opacity:.86,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.set(u.x,.09,u.z);this.scene.add(ring);this.effects.push({obj:ring,life:.27,update:dt=>{const grow=1+dt*23;ring.scale.multiplyScalar(grow);ring.material.opacity-=dt*3.6;}});this.vfxNova(u,tick%2?0xffdf79:COLORS.wind,1.15,6);}
  vfxKickArc(u,col){if($('#reducedFX').checked||!this.fxAllowed(1))return;const arc=new THREE.Mesh(new THREE.TorusGeometry(.82,.055,6,26,Math.PI*.86),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.9}));arc.rotation.x=Math.PI/2;arc.rotation.z=-1.0;arc.position.set(u.x,1.05,u.z);this.scene.add(arc);this.effects.push({obj:arc,life:.24,follow:u,update:dt=>{arc.rotation.z+=dt*19;arc.scale.multiplyScalar(1+dt*1.7);arc.material.opacity-=dt*4.2;arc.position.set(u.x,1.08,u.z);}});}
  vfxSlicingWinds(c,t,slash=0){if($('#reducedFX').checked||!this.fxAllowed(1)||!t)return;const holder=new THREE.Group(),colours=[0xf4ecff,0xb869ff,0xff5da8],material=i=>new THREE.MeshBasicMaterial({color:colours[(slash+i)%colours.length],transparent:true,opacity:.96,depthWrite:false,blending:THREE.AdditiveBlending});for(let i=0;i<2;i++){const blade=new THREE.Mesh(new THREE.BoxGeometry(2.45,.085,.035),material(i));blade.rotation.z=(i?1:-1)*(.64+slash*.025);holder.add(blade);}holder.position.set(t.x,1.28,t.z);holder.quaternion.copy(this.camera.quaternion);this.scene.add(holder);this.effects.push({obj:holder,life:.24,follow:t,update:dt=>{holder.position.set(t.x,1.28,t.z);holder.quaternion.copy(this.camera.quaternion);holder.scale.multiplyScalar(1+dt*2.8);holder.children.forEach(m=>m.material.opacity-=dt*4.4);}});this.vfxKickArc(t,slash%2?0xff67b7:0xc277ff);}
 vfxAvengingWings(u,dur=6){if($('#reducedFX').checked)return;const group=new THREE.Group();const baseY=1.50;for(const side of[-1,1]){for(let i=0;i<5;i++){const feather=new THREE.Mesh(new THREE.PlaneGeometry(.62-.05*i,1.28-.12*i),new THREE.MeshBasicMaterial({color:i<2?0xffffdc:0xffdb73,transparent:true,opacity:.88,side:THREE.DoubleSide}));feather.position.set(side*(.95+.18*i),baseY-.07*i,-.06+.02*i);feather.rotation.y=side*(.80+.08*i);feather.rotation.z=side*(.95+i*.16);group.add(feather);}}const halo=new THREE.Mesh(new THREE.RingGeometry(.46,.56,28),new THREE.MeshBasicMaterial({color:0xfff3b8,transparent:true,opacity:.78,side:THREE.DoubleSide}));halo.rotation.x=-Math.PI/2;halo.position.y=2.28;group.add(halo);const ground=new THREE.Mesh(new THREE.RingGeometry(.88,1.16,28),new THREE.MeshBasicMaterial({color:0xffd66c,transparent:true,opacity:.34,side:THREE.DoubleSide}));ground.rotation.x=-Math.PI/2;ground.position.y=.06;group.add(ground);this.scene.add(group);let elapsed=0;this.effects.push({obj:group,life:dur,follow:u,update:dt=>{elapsed+=dt;group.position.set(u.x,0,u.z);const flap=.22+Math.sin(elapsed*10)*.18;for(let wi=0;wi<2;wi++){for(let i=0;i<5;i++){const feather=group.children[wi*5+i];feather.rotation.y=(wi===0?-1:1)*(.80+.08*i+flap);feather.material.opacity=.72+.16*Math.sin(elapsed*9+i+wi);}}halo.rotation.z+=dt*1.8;ground.material.opacity=.28+.14*Math.sin(elapsed*6);}});}
 vfxDivineSteed(u,dur=3){if($('#reducedFX').checked)return;const group=new THREE.Group();const ring=new THREE.Mesh(new THREE.RingGeometry(.72,.98,32),new THREE.MeshBasicMaterial({color:0xffdd79,transparent:true,opacity:.82,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;group.add(ring);for(let i=0;i<10;i++){const streak=new THREE.Mesh(new THREE.BoxGeometry(.05,.05,.65),new THREE.MeshBasicMaterial({color:i%2?0xffffc8:0xffcf60,transparent:true,opacity:.82}));streak.position.set(Math.cos(i/10*Math.PI*2)*.78,.12,Math.sin(i/10*Math.PI*2)*.78);streak.rotation.y=i/10*Math.PI*2;group.add(streak);}this.scene.add(group);let elapsed=0;this.effects.push({obj:group,life:dur,follow:u,update:dt=>{elapsed+=dt;group.position.set(u.x,0,u.z);ring.rotation.z+=dt*4;for(let i=1;i<group.children.length;i++){const s=group.children[i];s.material.opacity=.60+.18*Math.sin(elapsed*12+i);s.scale.z=1.0+.30*Math.sin(elapsed*10+i);}}});}
  vfxWillowGuard(u,dur=6){if($('#reducedFX').checked)return;const group=new THREE.Group();const jade=new THREE.MeshBasicMaterial({color:0x72ffb1,transparent:true,opacity:.62,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});const gold=new THREE.MeshBasicMaterial({color:0xffdf79,transparent:true,opacity:.54,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});const base=new THREE.Mesh(new THREE.RingGeometry(1.15,1.42,48),jade);base.rotation.x=-Math.PI/2;base.position.y=.07;group.add(base);const dome=new THREE.Mesh(new THREE.SphereGeometry(1.18,24,12,0,Math.PI*2,0,Math.PI*.58),jade);dome.position.y=.08;dome.scale.y=.82;group.add(dome);for(let i=0;i<14;i++){const leaf=new THREE.Mesh(new THREE.ConeGeometry(.055,.28,5),i%3?jade:gold);leaf.userData.phase=i*.67;group.add(leaf);}for(let i=0;i<5;i++){const strand=new THREE.Mesh(new THREE.CylinderGeometry(.012,.018,1.55,5),i%2?jade:gold);strand.position.set(Math.cos(i/5*Math.PI*2)*.52,.82,Math.sin(i/5*Math.PI*2)*.52);strand.rotation.z=.25*Math.sin(i);group.add(strand);}this.scene.add(group);let time=0;this.effects.push({obj:group,life:dur,follow:u,update:dt=>{time+=dt;group.position.set(u.x,0,u.z);base.rotation.z+=dt*2.7;dome.rotation.y-=dt*.65;base.material.opacity=.42+.16*Math.sin(time*7);dome.material.opacity=.22+.10*Math.sin(time*5);group.children.slice(2,16).forEach((leaf,i)=>{const a=time*(2.2+(i%3)*.25)+i*Math.PI/7;const r=1.02+.22*Math.sin(time*2+i);leaf.position.set(Math.cos(a)*r,.55+.48*Math.sin(time*2.6+i),Math.sin(a)*r);leaf.rotation.z=-a+Math.PI/2;leaf.rotation.x=.6*Math.sin(time*3+i);leaf.material.opacity=.48+.28*Math.sin(time*5+i);});group.children.slice(16).forEach((s,i)=>{s.material.opacity=.32+.22*Math.sin(time*4+i);s.rotation.y+=dt*(1.1+i*.12);});}});}
  vfxCyclone(u,col,dur=.7){if($('#reducedFX').checked)return;const group=new THREE.Group();for(let i=0;i<3;i++){const ring=new THREE.Mesh(new THREE.TorusGeometry(.42+i*.2,.035,6,22),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.8}));ring.rotation.x=Math.PI/2;ring.position.y=.4+i*.43;group.add(ring);}group.position.set(u.x,0,u.z);this.scene.add(group);this.effects.push({obj:group,life:dur,follow:u,update:dt=>{group.position.set(u.x,0,u.z);group.rotation.y+=dt*13;group.children.forEach((r,i)=>{r.scale.multiplyScalar(1+dt*(.26+i*.18));r.material.opacity-=dt*(.55+i*.12);});}});}
 vfxSlash(u,col){if($('#reducedFX').checked)return;const arc=new THREE.Mesh(new THREE.TorusGeometry(.72,.045,6,22,Math.PI*.72),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.9}));arc.rotation.x=Math.PI/2;arc.rotation.z=-.45;arc.position.set(u.x,1.05,u.z);this.scene.add(arc);this.effects.push({obj:arc,life:.18,follow:u,update:dt=>{arc.rotation.z+=dt*16;arc.material.opacity-=dt*5;arc.position.set(u.x,1.05,u.z);}});}
 vfxTrail(u,col){const m=new THREE.Mesh(new THREE.CylinderGeometry(.7,.7,.035,16),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.55}));m.position.set(u.x,.04,u.z);this.scene.add(m);this.effects.push({obj:m,life:.42,update:dt=>{m.scale.multiplyScalar(1+dt*2);m.material.opacity-=dt*1.5;}});this.vfxNova(u,col,1.05,5);}
 smokeBombShroud(u,dur){if($('#reducedFX').checked)return;const dome=new THREE.Mesh(new THREE.SphereGeometry(2.25,18,12),new THREE.MeshBasicMaterial({color:0x1b1426,transparent:true,opacity:.42,wireframe:true}));dome.position.set(u.x,1.15,u.z);this.scene.add(dome);const ring=new THREE.Mesh(new THREE.RingGeometry(1.8,2.15,30),new THREE.MeshBasicMaterial({color:0x704d91,transparent:true,opacity:.62,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.set(u.x,.08,u.z);this.scene.add(ring);this.effects.push({obj:dome,life:dur,follow:u,update:dt=>{if(!u.alive||!u.has('smokeBomb'))dome.dead=true;else{dome.position.set(u.x,1.15,u.z);dome.rotation.y+=dt*.7;}}});this.effects.push({obj:ring,life:dur,follow:u,update:dt=>{if(!u.alive||!u.has('smokeBomb'))ring.dead=true;else{ring.position.set(u.x,.08,u.z);ring.rotation.z+=dt*.42;}}});}
 vfxIceBlock(u,dur=8){if($('#reducedFX').checked)return;const group=new THREE.Group();const iceMat=new THREE.MeshStandardMaterial({color:0xa8e7ff,emissive:0x7fd8ff,emissiveIntensity:.35,transparent:true,opacity:.62,roughness:.28,metalness:.12});const core=new THREE.Mesh(new THREE.OctahedronGeometry(1.22,1),iceMat);core.scale.set(.86,1.35,.86);core.position.y=1.12;group.add(core);for(let i=0;i<6;i++){const shard=new THREE.Mesh(new THREE.ConeGeometry(.16,.88,5),iceMat.clone());const ang=i/6*Math.PI*2;shard.position.set(Math.cos(ang)*.72,.48,Math.sin(ang)*.72);shard.rotation.z=Math.cos(ang)*.2;group.add(shard);}this.scene.add(group);let elapsed=0;this.effects.push({obj:group,life:dur,follow:u,update:dt=>{elapsed+=dt;if(!u.has('iceBlock')){group.children.forEach(ch=>ch.material.opacity=Math.max(0,ch.material.opacity-dt*4));if(elapsed>.18)group.dead=true;return;}group.position.set(u.x,0,u.z);core.rotation.y+=dt*.55;group.children.forEach((ch,i)=>{if(i>0)ch.material.opacity=.48+.14*Math.sin(elapsed*8+i);});}});}
 shieldBubble(u,col,dur){const m=new THREE.Mesh(new THREE.SphereGeometry(1.18,18,14),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.2,wireframe:true}));m.position.set(u.x,1.15,u.z);this.scene.add(m);this.vfxGlyph(u,col,.65);this.effects.push({obj:m,life:dur,follow:u,update:dt=>{if(!u.alive||u.shield<=0)m.dead=true;else{m.visible=!u.has('stealth');m.position.set(u.x,1.15,u.z);m.rotation.y+=dt*.7;}}});}
 healBolt(c,t){this.vfxSpiral(c,COLORS.heal,.42);this.projectile(c,t,'heal',()=>{this.vfxBurst(t,COLORS.heal,.65);this.vfxSpiral(t,0xffe08a,.65);});}
 flash(mesh,col){this.shake=Math.max(this.shake,.03);}
 float(u,text,kind,override){if(text==='VEIL'&&u?.cls==='flame')text=u.has('alterTime')?'ALTER TIME · SAVED':'ALTER TIME · RETURNED';if((kind==='heal'||kind==='info')&&progression.settings?.hideCombatText)return;const v=typeof text==='number'?String(Math.round(text)):text;const d=document.createElement('div');d.className=`floater ${kind}`;d.textContent=override||((kind==='heal'?'+':'-')+v);let p=this.toScreen(u);d.style.left=p.x+'px';d.style.top=p.y+'px';$('#floaters').appendChild(d);setTimeout(()=>d.remove(),1000);}
 toScreen(u){const v=this.screenProjectVector||(this.screenProjectVector=new THREE.Vector3());v.set(u.visualX??u.x,2.8,u.visualZ??u.z).project(this.camera);const point=u._screenPoint||(u._screenPoint={x:0,y:0});point.x=(v.x*.5+.5)*innerWidth;point.y=(-.5*v.y+.5)*innerHeight;return point;}
 message(msg){const el=$('#message');el.textContent=msg;el.style.opacity=1;clearTimeout(this.msgTimer);this.msgTimer=setTimeout(()=>el.style.opacity=0,1000);}
 log(s){this.logs.unshift(`[${fmt(this.time)}] ${s}`);this.logs=this.logs.slice(0,20);}
 abilityStackBadge(unit,ability){if(!unit||!ability)return '';if(ability.name==='Tigereye Brew'){const stacks=windTigereyeStacks(unit);return `<span class="stack-badge brew-stack-badge ${stacks<=0?'empty':''} ${stacks>=6?'full':''}" title="Tigereye Brew stacks: ${stacks} of 6"><strong>${stacks}</strong><small>/6</small></span>`;}if(ability.name==='Penance'&&unit.has('radiantPenanceProc'))return `<span class="stack-badge">✦</span>`;if(unit.has('natureSwiftness')&&['Renewal Tide','Lullaby Bloom'].includes(ability.name))return `<span class="stack-badge">🌿</span>`;return '';}  extraToolkitDisplayOrder(cls){
 const list=AB[cls]||[];
 const force=new Set(cls==='shadow'?['Shiv']:[]);
 if(!force.size)return list.map((a,i)=>({a,i,forced:false}));
 const normal=[],forced=[];
 list.forEach((a,i)=>(force.has(a.name)?forced:normal).push({a,i,forced:force.has(a.name)}));
 return normal.slice(0,7).concat(forced,normal.slice(7));
}
  
spawnTotemMasteryVisuals(u,duration=20){
 if(!u||!u.mesh||!this.scene)return;
 this.clearTotemMasteryVisuals(u);
 const root=new THREE.Group();
 root.name='TotemMasteryVisuals';
 const colors=[0x78dfff,0x7dff8b,0xa77dff,0xffd36a];
 const labels=['DAMAGE','HEALING','SHIELD','SURGE'];
 const angles=[0,Math.PI/2,Math.PI,Math.PI*1.5];
 const mats=colors.map(c=>new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:.86}));
 angles.forEach((a,i)=>{
  const g=new THREE.Group();
  const base=new THREE.Mesh(new THREE.CylinderGeometry(.13,.18,.12,6),mats[i]);
  base.position.y=.09;
  const body=new THREE.Mesh(new THREE.CylinderGeometry(.13,.18,.58,6),mats[i]);
  body.position.y=.45;
  const cap=new THREE.Mesh(new THREE.ConeGeometry(.22,.20,6),mats[i]);
  cap.position.y=.86;
  const ring=new THREE.Mesh(new THREE.RingGeometry(.24,.30,12),new THREE.MeshBasicMaterial({color:colors[i],transparent:true,opacity:.55}));
  ring.position.y=.70;
  ring.rotation.x=Math.PI/2;
  g.add(base,body,cap,ring);
  const r=1.65;
  g.position.set(Math.cos(a)*r,0,Math.sin(a)*r);
  g.userData={angle:a,label:labels[i],bob:Math.random()*Math.PI*2};
  root.add(g);
 });
 root.userData={owner:u,expires:this.time+duration};
 u.totemVisuals=root;
 this.scene.add(root);
 this.updateTotemMasteryVisuals();
}
clearTotemMasteryVisuals(u){
 if(u&&u.totemVisuals){
  this.scene.remove(u.totemVisuals);
  u.totemVisuals.traverse?.(o=>{if(o.geometry)o.geometry.dispose?.();});
  u.totemVisuals=null;
 }
}
updateTotemMasteryVisuals(){
 this.units?.forEach(u=>{
  const root=u.totemVisuals;
  if(!root)return;
  if(!u.alive||!u.has?.('totemMastery')){
   this.clearTotemMasteryVisuals(u);
   return;
  }
  root.position.copy(u.mesh.position);
  root.children.forEach((g,i)=>{
   g.rotation.y+=0.012+(i*.0015);
   g.position.y=.05+Math.sin((this.time*2.6)+(g.userData.bob||0))*.035;
  });
 });
}


spawnCombustionVisuals(u,duration=8){
 if(!u||!u.mesh||!this.scene)return;
 this.clearCombustionVisuals(u);
 const root=new THREE.Group();root.name='CombustionFlames';
 const mat=new THREE.MeshBasicMaterial({color:0xff5a1f,transparent:true,opacity:.72,depthWrite:false,blending:THREE.AdditiveBlending});
 const gold=new THREE.MeshBasicMaterial({color:0xffd067,transparent:true,opacity:.50,depthWrite:false,blending:THREE.AdditiveBlending});
 for(let i=0;i<14;i++){const flame=new THREE.Mesh(new THREE.ConeGeometry(.10+Math.random()*.08,.55+Math.random()*.45,7),i%3?mat:gold);const a=(i/14)*Math.PI*2,r=.28+Math.random()*.42;flame.position.set(Math.cos(a)*r,.35+Math.random()*1.35,Math.sin(a)*r);flame.rotation.z=(Math.random()-.5)*.45;flame.userData={a,r,baseY:flame.position.y,phase:Math.random()*6.28};root.add(flame);}
 const aura=new THREE.Mesh(new THREE.RingGeometry(.82,1.08,48),new THREE.MeshBasicMaterial({color:0xff7a25,transparent:true,opacity:.36,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending}));aura.rotation.x=-Math.PI/2;aura.position.y=.04;root.add(aura);root.userData={owner:u,expires:this.time+duration,aura};u.combustionVisuals=root;this.scene.add(root);this.updateCombustionVisuals();
}
clearCombustionVisuals(u){if(u&&u.combustionVisuals){this.scene.remove(u.combustionVisuals);u.combustionVisuals.traverse?.(o=>{o.geometry?.dispose?.();});u.combustionVisuals=null;}}
updateCombustionVisuals(){this.units?.forEach(u=>{const root=u.combustionVisuals;if(!root)return;if(!u.alive||!u.has?.('combustion')){this.clearCombustionVisuals(u);return;}root.position.copy(u.mesh.position);root.children.forEach((f,i)=>{if(f.userData?.phase!==undefined){const p=f.userData.phase+this.time*4.2;f.position.y=f.userData.baseY+Math.sin(p)*.09;f.scale.setScalar(.86+.26*Math.sin(p+i));f.rotation.y+=.035;}});if(root.userData.aura)root.userData.aura.rotation.z+=.025;});}

renderActions(){
 syncTalentUnlockedAbilities();
 const bar=$('#actionbar');
 if(!this.player){bar.innerHTML='';$('#castWrap').classList.remove('above-extra-row');return;}
 const activeMount=mountDefinition(progression.activeMount);
 const trinket=`<button id="trinketBtn" class="utility-btn" aria-label="Gladiator's Medallion" title="Gladiator's Medallion — Break crowd control"><span class="u-key" id="trinketKey">${bindLabel(binds.trinket)}</span><span class="u-icon">🏅</span><span class="u-title">Medallion</span><span class="u-state">Break CC</span><span class="u-cd"></span></button>`;
 const mount=`<button id="mountBtn" class="utility-btn" aria-label="Summon ${activeMount.name}" title="${activeMount.name} — 1.5 sec out-of-combat mount"><span class="u-key" id="mountKey">${bindLabel(binds.mount)}</span><span class="u-icon">${activeMount.icon}</span><span class="u-title">${activeMount.name.split(' ')[0]}</span><span class="u-state" id="mountState">Mount</span><span class="u-cd"></span></button>`;
 const makeButton=(item,emptySlot)=>{
  if(!item){const slot=emptySlot;return `<button class="ability ability-empty" data-slot="${slot}" aria-label="Empty fixed keybind slot ${slot+1}"><span class="key">${bindLabel(binds['a'+(slot+1)])}</span><span class="empty-plus">+</span><span class="aname">Empty</span></button>`;}
  const {a,i,slot,forced=false}=item;
  const slotBind=binds['a'+(slot+1)];
  return `<button class="ability interactive ${forced?'extra-toolkit-forced':''}" data-i="${i}" data-slot="${slot}" draggable="true" aria-label="${a.name} — drag to move this spell to another ${CLASS_INFO[this.player.cls].name} keybind slot"><span class="key">${bindLabel(slotBind)}</span><span class="icon">${abilityIcon(a)}</span>${this.abilityStackBadge(this.player,a)}<span class="aname">${a.name}</span><span class="cd"></span><span class="gcdOverlay"></span><span class="lock-overlay"></span></button>`;
 };
 const ordered=this.classAbilityDisplayOrder(this.player.cls);
 const primary=ordered.slice(0,7).map((item,index)=>makeButton(item,index)).join('');
 const extras=ordered.slice(7,14).map((item,index)=>makeButton(item,index+7)).join('');
 bar.innerHTML=`<div class="actionbar-toolkit">${extras}</div><div class="actionbar-main">${trinket}${primary}${mount}</div>`;
 $('#castWrap').classList.add('above-extra-row');
 $('#trinketBtn').onclick=()=>this.useTrinket();$('#mountBtn').onclick=()=>this.toggleMount();
 $('#trinketBtn').onmouseenter=()=>this.showUtilityTooltip('trinket',$('#trinketBtn'));$('#trinketBtn').onfocus=()=>this.showUtilityTooltip('trinket',$('#trinketBtn'));$('#trinketBtn').onmouseleave=()=>this.hideAbilityTooltip();$('#trinketBtn').onblur=()=>this.hideAbilityTooltip();
 $('#mountBtn').onmouseenter=()=>this.showUtilityTooltip('mount',$('#mountBtn'));$('#mountBtn').onfocus=()=>this.showUtilityTooltip('mount',$('#mountBtn'));$('#mountBtn').onmouseleave=()=>this.hideAbilityTooltip();$('#mountBtn').onblur=()=>this.hideAbilityTooltip();
 bar.querySelectorAll('.ability').forEach(b=>{
  const i=+b.dataset.i,slot=+b.dataset.slot;
  if(!Number.isInteger(i)){b.ondragover=e=>{e.preventDefault();if(this.draggedAbilitySlot!==slot)b.classList.add('ability-drop-target');};b.ondragleave=()=>b.classList.remove('ability-drop-target');b.ondrop=e=>{e.preventDefault();e.stopPropagation();b.classList.remove('ability-drop-target');const fromSlot=Number(e.dataTransfer.getData('text/plain'));if(Number.isInteger(fromSlot))this.swapAbilitySlots(fromSlot,slot);};return;}
  b.onclick=()=>{if(performance.now()<(this.suppressAbilityClickUntil||0))return;this.playerCast(i);};
  b.onmouseenter=()=>this.showAbilityTooltip(i,b);b.onfocus=()=>this.showAbilityTooltip(i,b);b.onmouseleave=()=>this.hideAbilityTooltip();b.onblur=()=>this.hideAbilityTooltip();
  b.ondragstart=e=>{this.draggedAbilitySlot=slot;this.suppressAbilityClickUntil=performance.now()+350;b.classList.add('ability-dragging');bar.classList.add('ability-drag-active');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(slot));this.hideAbilityTooltip();};
  b.ondragover=e=>{e.preventDefault();if(this.draggedAbilitySlot!==slot)b.classList.add('ability-drop-target');e.dataTransfer.dropEffect='move';};
  b.ondragleave=()=>b.classList.remove('ability-drop-target');
  b.ondrop=e=>{e.preventDefault();e.stopPropagation();b.classList.remove('ability-drop-target');const fromSlot=Number(e.dataTransfer.getData('text/plain'));if(Number.isInteger(fromSlot))this.swapAbilitySlots(fromSlot,slot);};
  b.ondragend=()=>{this.suppressAbilityClickUntil=performance.now()+180;this.draggedAbilitySlot=null;bar.classList.remove('ability-drag-active');bar.querySelectorAll('.ability').forEach(x=>x.classList.remove('ability-dragging','ability-drop-target'));};
 });
 const nearestAbility=(x,y)=>[...bar.querySelectorAll('.ability')].reduce((best,button)=>{const r=button.getBoundingClientRect(),distance=Math.hypot(x-(r.left+r.width/2),y-(r.top+r.height/2));return !best||distance<best.distance?{button,distance}:best;},null)?.button||null;
 bar.ondragover=e=>{if(!Number.isInteger(this.draggedAbilitySlot))return;e.preventDefault();const target=nearestAbility(e.clientX,e.clientY);bar.querySelectorAll('.ability-drop-target').forEach(x=>x.classList.remove('ability-drop-target'));if(target&&Number(target.dataset.slot)!==this.draggedAbilitySlot)target.classList.add('ability-drop-target');e.dataTransfer.dropEffect='move';};
 bar.ondrop=e=>{if(!Number.isInteger(this.draggedAbilitySlot))return;e.preventDefault();const target=nearestAbility(e.clientX,e.clientY),toSlot=Number(target?.dataset.slot);if(Number.isInteger(toSlot)&&toSlot!==this.draggedAbilitySlot)this.swapAbilitySlots(this.draggedAbilitySlot,toSlot);};
}
  abilityCategory(a){if(['heal','hot','bigHeal','shield','cleanse','healerEscape','natureSwiftness','undyingResolve','holyLight','sacrifice','intercept','healingStreamTotem','paladinAoE','paladinGuard','discShield','discMend','painSuppression','ultimateRadiance','discFade','archangel','darkArchangel','angelicBody','avengingWings'].includes(a.type))return ['Support','heal'];if(a.type==='holyShock')return ['Holy Shock · Heal / Damage','heal'];if(['poly','sleep','blind','fear','root','stun','singleStun','groundStun','slow','interrupt','interruptProc','paladinStun','stormbolt'].includes(a.type))return ['Control','control'];if(['defensive','shieldSelf','buff','dash','push','paladinSteed','sharpenBlade'].includes(a.type))return ['Utility','mana'];if(['soulDot','agony','immolate','unstableAffliction','soulDrain','chaosBolt'].includes(a.type))return ['Affliction','damage'];return ['Damage','damage'];}
 showAbilityTooltip(i,button){if(!this.player)return;const slot=Number.isInteger(Number(button?.dataset?.slot))?Number(button.dataset.slot):i;const a=AB[this.player.cls][i],tt=$('#abilityTooltip'),cat=this.abilityCategory(a),rect=button.getBoundingClientRect();const cast=a.cast?`${a.cast.toFixed(2)}s Cast`:'Instant';const range=a.range?`${a.range}m Range`:'Self';const resource=this.player.info.resource==='energy'?'Energy':'Mana';let active='';
  if(a.name==='Holy Light'&&this.player.has('infusion'))active='<div class="tt-active">✨ Infusion of Light — Next Holy Light casts 50% faster and refunds mana</div>';
  if(a.name==='Blessing of Sacrifice'&&this.player.has('avengingWings'))active='<div class="tt-active">🪽 Sacrifice Wings Active — Healing increased by 20%</div>';if(a.name==='Avenging Wings'&&this.player.has('avengingWings'))active='<div class="tt-active">🪽 Avenging Wings Active — Damage and healing increased by 20%</div>';
  if(a.name==='Divine Steed'&&this.player.has('divineSteed'))active='<div class="tt-active">🐴 Divine Steed Active — Movement speed increased by 65%</div>';
  if(a.name==='Cinder Bolt'&&this.player.has('instantBolt'))active=`<div class="tt-active">✨ Hot Streak Active — ${this.player.has('instantBolt').stacks||2} Instant +20% Cinder Bolts Ready</div>`;
  if(a.name==='Ember Lance'&&this.player.has('meteorLance'))active=`<div class="tt-active">☄️ Meteor Lance ready — the next Ember Lance deals 15% more damage and can be fired immediately between your other abilities</div>`;
  if(a.name==='Forked Current'&&this.player.has('overload'))active='<div class="tt-active">🌋 Volcanic Overload — +35% Forked Damage + Triple Lava on Visible Enemies + Mana</div>';if(a.name==='Arc Spark'&&this.player.has('tempestBolts'))active=`<div class="tt-active">⚡ Tempest Bolts Active — ${this.player.has('tempestBolts').stacks||2} empowered +25% bolts ready · 0.25 sec interval</div>`;if(a.name==='Night Slash'&&this.player.has('eviscerateReady'))active='<div class="tt-active">⚔️ Eviscerate Ready — Next Night Slash deals +45% damage</div>';if(a.name==='Mortal Swing'&&this.player.has('warbreakerReady'))active='<div class="tt-active">🪓 Warbreaker Ready — only your next Mortal Swing deals +20%, then the buff is consumed</div>';if(a.name==='Victory Rush'&&this.player.has('victoryRushBoost'))active='<div class="tt-active">🏆 Victory Rush Primed — Shield Wall makes this Victory Rush heal 60% more</div>';if(a.name==='Zephyr Palm'&&this.player.has('risingSunReady'))active='<div class="tt-active">🌅 Rising Sun Kick Ready — Strike of the Windlord empowered this attack</div>';if(a.type==='volcanicEruption'&&this.player.has('volcanicEruptionReady'))active='<div class="tt-active">🌋 Volcanic Eruption Ready — consume the Skybreaker charge</div>';if(a.name==='Pandemic Bloom'&&this.player.has('pandemicSurge'))active='<div class="tt-active">🌑 Shadowfury — Pandemic Bloom deals +20%</div>';if(a.name==='Arc Spark'&&this.player.has('stormkeeper'))active='<div class="tt-active">⚡ Stormkeeper — 3 free instant Arc Sparks, +10% Arc Spark damage only</div>';if(this.player.has('natureSwiftness')&&a.name==='Lullaby Bloom')active='<div class="tt-active">🌿 Nature Swiftness — Lullaby Bloom is instant and can be used even while on cooldown</div>';if(this.player.has('natureSwiftness')&&a.name==='Renewal Tide')active='<div class="tt-active">🌿 Nature Swiftness — Renewal Tide can be used immediately even while on cooldown</div>';if(a.name==='Cloudstep Kick'&&!this.player.has('cloudstepDashCd'))active='<div class="tt-active">💨 Cloudstep Dash Ready — 11m Leap +20% Damage</div>';if(a.name==='Viper Cut'&&this.player.has('venomEdge'))active='<div class="tt-active">🦂 Venom Edge Active — Empowered Poison Finisher</div>';if(a.name==='Cyclone Barrage'&&this.player.has('tempestFlow'))active='<div class="tt-active">🌪️ Tempest Flow Active — Empowered Multi-hit Combo</div>';if(a.name==='Cloudstep Kick'&&this.player.has('dawncrest'))active='<div class="tt-active">☀️ Dawncrest Ready — Becomes Dawncrest Kick for 238 damage</div>';if(a.name==='Cyclone Barrage'&&this.player.has('furyReady'))active='<div class="tt-active">🥊 Fists of Fury Ready — Channel 2.5 sec, stunning and pummelling nearby enemies</div>';if(a.name==='Mortal Swing'&&this.player.has('empoweredSwing'))active=`<div class="tt-active">⚔️ Empowered Slams Active — ${this.player.has('empoweredSwing').stacks||2} double-slash Mortal Swing${(this.player.has('empoweredSwing').stacks||2)===1?'':'s'} ready · Each hit +15% damage</div>`;
  if(a.name==='Mortal Swing'&&this.player.has('empoweredSwing'))active=`<div class="tt-active">⚔️ Pummel Empowerment — one Mortal Swing deals +30%${this.player.has('warbreakerReady')?' and stacks with Warbreaker':''}</div>`;
  if(a.name==='Mortal Swing'&&this.player.has('warbreakerReady')&&!this.player.has('empoweredSwing'))active='<div class="tt-active">🪓 Warbreaker Ready — your next Mortal Swing deals +30%, then the buff is consumed</div>';
  if(a.name==='Cloudstep Kick'&&!this.player.has('cloudstepDashCd'))active='<div class="tt-active">💨 Cloudstep Dash ready — serpent kick up to 17m and deal 20% more damage</div>';
  if(a.name==='Verdant Mend'&&this.player.has('renewalVerdant'))active='<div class="tt-active">🌿 Renewal Tide empowerment ready — this Verdant Mend heals for 150% more and consumes the effect</div>';
  const locked=this.player.has('lock_'+a.school)||this.player.has('silence');if(locked)active=`<div class="tt-lock">🔒 ${a.school.toUpperCase()} SCHOOL LOCKED · ${locked.time.toFixed(1)}s remaining — this ability cannot be used.</div>${active}`;
	  const dragHint='<div style="margin-top:7px;padding-top:6px;border-top:1px solid rgba(255,255,255,.09);font-size:10px;color:#9fc7d4">Drag onto another ability icon to move this spell into that fixed keybind slot. Layouts are saved separately for each class.</div>';const cooldown=a.cd?`Cooldown: ${Number.isInteger(a.cd)?a.cd:a.cd.toFixed(1)}s`:'No cooldown',damagePreview=this.gearAdjustedAbilityTooltip(a);tt.innerHTML=`<div class="tt-head"><div class="tt-name">${abilityIcon(a)} ${a.name}</div><div class="tt-bind">${bindLabel(binds['a'+(slot+1)])}</div></div><div class="tt-badges"><span class="tt-badge ${cat[1]}">${cat[0]}</span><span class="tt-badge">${cast}</span><span class="tt-badge">${range}</span><span class="tt-badge mana">${a.cost} ${resource}</span><span class="tt-badge">${cooldown}</span></div><div class="tt-description">${damagePreview.description}</div>${damagePreview.note}<div class="tt-extra">${CLASS_MECHANICS[this.player.cls]}${dragHint}</div>${active}`;
  tt.classList.remove('hidden');const left=clamp(rect.left+rect.width/2-170,12,innerWidth-352);tt.style.left=`${left}px`;tt.style.bottom=`${innerHeight-rect.top+10}px`;
 }
 showUtilityTooltip(kind,button){
  if(!this.player)return;const tt=$('#abilityTooltip'),rect=button.getBoundingClientRect();let data;
  if(kind==='trinket'){
   const cd=Math.ceil(this.player.trinketCd||0),active=cd>0?`<div class="tt-active">ON COOLDOWN · ${cd}s REMAINING</div>`:'<div class="tt-active">READY TO BREAK CROWD CONTROL</div>';
   data={icon:'🏅',name:"Gladiator's Medallion",bind:keyLabel(binds.trinket),badges:['Utility','Instant','Self','60s CD'],desc:'Removes any active stun, root, fear, Hex, blind, sleep or incapacitate effect from your character. Can be pressed while crowd controlled.',extra:'A crucial arena defensive. Save it for dangerous crowd-control chains or a kill attempt.',active};
  }else{
   const active=this.player.mounted?'<div class="tt-active">MOUNTED · ATTACKING OR TAKING DAMAGE DISMOUNTS YOU</div>':'';
   data={icon:'🐎',name:'Summon Skyhoof',bind:keyLabel(binds.mount),badges:['Utility','1.50s Cast','Self','Out of Combat'],desc:'Summon your arena mount while out of combat, increasing movement speed until combat begins.',extra:'Cannot be summoned in combat. Attacking or being attacked automatically dismounts the rider.',active};
  }
  tt.innerHTML=`<div class="tt-head"><div class="tt-name">${data.icon} ${data.name}</div><div class="tt-bind">${data.bind}</div></div><div class="tt-badges">${data.badges.map((b,i)=>`<span class="tt-badge ${i===0?'mana':''}">${b}</span>`).join('')}</div><div class="tt-description">${data.desc}</div><div class="tt-extra">${data.extra}</div>${data.active}`;
  tt.classList.remove('hidden');const left=clamp(rect.left+rect.width/2-170,12,innerWidth-352);tt.style.left=`${left}px`;tt.style.bottom=`${innerHeight-rect.top+10}px`;
 }
 hideAbilityTooltip(){$('#abilityTooltip').classList.add('hidden');}
 renderFrames(){this.resetPerformance();this.applyHudScale();this.applyHudLayout();this.unitFrameElements=[];this.frameInto($('#allyFrames'),this.units.filter(u=>u.team==='ally'&&!u.healingStreamTotem));this.frameInto($('#enemyFrames'),this.units.filter(u=>u.team==='enemy'&&!u.healingStreamTotem));this.enhanceUnitFrames();this.warmMatchRenderer();}
 enhanceUnitFrames(){this.unitFrameElements.forEach(frame=>{const unit=this.units[Number(frame.dataset.unit)];if(!unit)return;const colour=Number(CLASS_INFO[unit.cls]?.colour||0x596579),hex=`#${colour.toString(16).padStart(6,'0')}`,r=(colour>>16)&255,g=(colour>>8)&255,b=colour&255;frame.dataset.class=unit.cls;frame.style.setProperty('--class-frame',hex);frame.style.setProperty('--class-frame-rgb',`${r},${g},${b}`);frame.onpointerdown=event=>{if(this.hudEditMode)return;event.preventDefault();event.stopPropagation();this.target=unit;frame.focus?.({preventScroll:true});};frame.onselectstart=()=>false;});}
 frameInto(el,units){el.innerHTML=units.map((u,i)=>`<div class="unit-frame glass ${u.team}" data-unit="${this.units.indexOf(u)}">${u.team==='enemy'?`<div class="enemy-utility"><div class="enemy-dr-mini"></div><div class="enemy-medallion" title="Gladiator's Medallion"><span>🏅</span><span class="ready-dot">RDY</span></div></div>`:''}<div class="cc-frame"></div><div class="uf-head"><span class="uf-name">${u.isPlayer&&equippedAchievementTitle()?`<span class="uf-title">${equippedAchievementTitle()}</span>`:''}${u.team==='enemy'?`<span class="arena-slot">E${i+1}</span>`:''}${u.name}</span><span class="uf-class">${classIcon(u.cls,u.info.badge)} ${u.info.short} <span class="role-tag">${u.info.role}</span></span></div><div class="bar"><div class="fill hp"></div><div class="shield-fill"></div><span class="bartext"></span></div><div class="bar"><div class="fill resource"></div></div><div class="effects"></div><div class="mini-cast hidden"><div class="mini-fill"></div><span class="mini-label"></span></div></div>`).join('');el.querySelectorAll('.unit-frame').forEach(f=>{const u=this.units[+f.dataset.unit];u.frameHud={frame:f,hp:f.querySelector('.hp'),shield:f.querySelector('.shield-fill'),bartext:f.querySelector('.bartext'),resource:f.querySelector('.resource'),effects:f.querySelector('.effects'),medallion:f.querySelector('.enemy-medallion'),dr:f.querySelector('.enemy-dr-mini'),cc:f.querySelector('.cc-frame'),cast:f.querySelector('.mini-cast'),castFill:f.querySelector('.mini-fill'),castLabel:f.querySelector('.mini-label')};this.unitFrameElements.push(f);f.onclick=()=>this.target=u;});}
 effectChip(e){const meta=e.label==='Immolate'?EFFECT_META.immolate:effectMeta(e.type), buff=meta.buff||['hot','shield','burst','defensive'].includes(e.type), cc=meta.cc||['poly','stun','silence'].includes(e.type),timer=e.time>600?'':` ${Math.ceil(e.time)}`; return `<span class="eff ${buff?'buff':''} ${cc?'cc':''}">${meta.icon} ${meta.label}${e.stacks?` ×${e.stacks}`:''}${timer}</span>`;}
 visibleFrameCast(u){if(!this.player||!u||!u.cast||u.cast.special==='mount')return null;const a=u.cast.a;if(!a)return null;return u.cast;}
 castNameMarkup(cast){return cast&&cast.a?`${abilityIcon(cast.a)} <span>${cast.a.name}</span>`:'';}
 targetCastMarkup(u){const c=this.visibleFrameCast(u);if(!c)return '';const pct=Math.max(0,Math.min(100,(1-c.left/c.total)*100)),ward=!!u.has('interruptWard');return `<div class="target-cast ${ward?'interrupt-shielded':''}">${ward?'<span class="cast-shield">🛡</span>':''}<div class="target-cast-head">${this.castNameMarkup(c)}</div><div class="target-cast-track"><span style="width:${pct}%"></span></div></div>`;}
 ccMarkup(u){const cc=crowdControlState(u); if(!cc) return ''; return `<span class="cc-icon">${cc.icon}</span><span>${cc.label}</span><span class="timer">${cc.time.toFixed(1)}s</span>`;}
 drMarkup(u){if(!u||!u.dr)return '';const rows=[{key:'stun',icon:'⛔',css:'stun',title:'Stun DR reset'},{key:'fear',icon:'😱',css:'incap',title:'Fear DR reset'},{key:'incap',icon:(u.has('gouge')?'👁️':u.has('windIncap')?'💫':u.has('poly')?'🐑':u.has('sleep')?'🌸':'🐑/👁️/💫'),css:'incap',title:'Incapacitate DR reset'},{key:'disorient',icon:'👁️',css:'incap',title:'Disorient DR reset'},{key:'root',icon:'🕸️',css:'root',title:'Root DR reset'}];const visible=rows.map(row=>{const state=u.dr[row.key],remaining=Math.max(0,(state?.until||0)-this.time);if(!state||state.level<=0||remaining<=0)return '';const next=state.level>=3?'IMMUNE':state.level===2?'NEXT 25%':'NEXT 50%';return `<span class="dr-tracker ${row.css}" title="${row.title}">${row.icon} ${next} <span class="dr-time">${remaining.toFixed(1)}s</span></span>`;}).filter(Boolean).join('');return visible?`<span class="dr-stack">${visible}</span>`:'';}
 frameDRMarkup(u){if(!u||!u.dr)return '';const rows=[{key:'stun',icon:'⛔',css:'stun',title:'Stun diminishing returns'},{key:'fear',icon:'😱',css:'incap',title:'Fear diminishing returns'},{key:'incap',icon:'💫',css:'incap',title:'Incapacitate diminishing returns'},{key:'disorient',icon:'👁️',css:'incap',title:'Disorient diminishing returns'},{key:'root',icon:'🕸️',css:'root',title:'Root diminishing returns'}];return rows.map(row=>{const state=u.dr[row.key],remaining=Math.max(0,(state?.until||0)-this.time);if(!state||state.level<=0||remaining<=0)return '';const tier=state.level>=3?'IMM':state.level===2?'¼':'½';return `<span class="mini-dr ${row.css}" title="${row.title}: ${remaining.toFixed(1)} sec until reset">${row.icon}<b>${tier}</b><em>${remaining.toFixed(0)}s</em></span>`;}).filter(Boolean).join('');}
 renderMeter(box,stat,mode){if(!box||!this.units.length)return;const units=this.units.filter(u=>!u.healingStreamTotem).sort((a,b)=>b.stats[stat]-a.stats[stat]);const max=Math.max(1,...units.map(u=>u.stats[stat]));const total=Math.max(1,units.reduce((sum,u)=>sum+u.stats[stat],0));const html=units.map((u,i)=>{const value=Math.round(u.stats[stat]);const width=value/max*100;const pct=value/total*100;const unitIndex=this.units.indexOf(u);return `<div class="details-row clickable" data-report-mode="${mode}" data-report-unit="${unitIndex}" title="Open Encounter Details"><div class="details-fill ${mode==='healing'?'heal ':''}${u.team}" style="width:${width}%"></div><span class="details-rank">${i+1}.</span><span class="details-name"><span class="details-class">${classIcon(u.cls,u.info.badge)}</span>${u.name}</span><span class="details-value ${mode==='healing'?'heal-value':''}">${value.toLocaleString()} · ${pct.toFixed(0)}%</span></div>`;}).join('');this.setHudHtml(box,html);if(!box.dataset.meterBound){box.dataset.meterBound='1';box.onpointerdown=e=>{const row=e.target.closest('.details-row');if(!row||!box.contains(row))return;e.preventDefault();e.stopPropagation();this.openEncounterDetails(row.dataset.reportMode,+row.dataset.reportUnit);};}}
 encounterAbilityIcon(label){const exact=Object.values(AB).flat().find(a=>label===a.name||label.startsWith(a.name));if(exact)return exact.icon;const extras={'Burn':'🔥','Ignite':'🔥','Bleed':'🩸','Rend Bleed':'🩸','Gushing Wound':'🩸','Meteor Lance':'☄️','Auto Attack':'⚔️','Basic Attack':'⚔️','Melee':'⚔️','Absorb':'🛡️','HoT':'🌿','Regrowth':'🌿'};for(const [key,icon] of Object.entries(extras)){if(label.includes(key))return icon;}return '✦';}
  encounterBreakdownRows(values,total,mode,showIcons=false){const entries=Object.entries(values||{}).sort((a,b)=>b[1]-a[1]);if(!entries.length)return '<div class="details-empty">No events recorded for this player.</div>';const max=Math.max(1,...entries.map(entry=>entry[1]));return entries.map(([label,value])=>`<div class="enc-spell"><span class="enc-spell-bar ${mode==='healing'?'heal':''}" style="width:${value/max*100}%"></span>${showIcons?`<span class="enc-spell-icon">${this.encounterAbilityIcon(label)}</span>`:''}<span class="enc-spell-name">${label}</span><span class="enc-spell-num">${Math.round(value).toLocaleString()} <small>${(value/Math.max(1,total)*100).toFixed(1)}%</small></span></div>`).join('');}
 openEncounterDetails(mode='damage',unitIndex=null){if(!this.units.length)return;const stat=mode==='healing'?'healing':'damage';if(unitIndex===null||!this.units[unitIndex])unitIndex=this.units.indexOf(this.units.slice().sort((a,b)=>b.stats[stat]-a.stats[stat])[0]);this.encounterView={mode:mode==='healing'?'healing':'damage',unit:unitIndex};$('#encounterDetails').classList.remove('hidden');this.updateEncounterDetails();}
 closeEncounterDetails(){this.encounterView=null;$('#encounterDetails').classList.add('hidden');}
 updateEncounterDetails(){const panel=$('#encounterDetails');if(!panel||!this.encounterView)return;
 const previousScroll=[...panel.querySelectorAll('.enc-scroll')].map(s=>s.scrollTop||0);
 const activeScrollIndex=Number.isInteger(this.encounterScrollActive)?this.encounterScrollActive:-1;const mode=this.encounterView.mode,healing=mode==='healing',stat=healing?'healing':'damage';let selected=this.units[this.encounterView.unit];if(!selected||selected.healingStreamTotem){this.closeEncounterDetails();return;}const ranked=this.units.filter(u=>!u.healingStreamTotem).sort((a,b)=>b.stats[stat]-a.stats[stat]),max=Math.max(1,...ranked.map(u=>u.stats[stat])),totalAll=Math.max(1,ranked.reduce((sum,u)=>sum+u.stats[stat],0)),selectedTotal=selected.stats[stat],abilityMap=healing?selected.stats.healingByAbility:selected.stats.damageByAbility,targetMap=healing?selected.stats.healingByTarget:selected.stats.damageByTarget,enemyDeaths=this.units.filter(u=>u.team==='enemy'&&!u.alive&&!u.healingStreamTotem).length,allyDeaths=this.units.filter(u=>u.team==='ally'&&!u.alive&&!u.healingStreamTotem).length,status=this.phase==='ended'?'MATCH COMPLETE':'LIVE ENCOUNTER',title=healing?'Healing Done':'Damage Done';const ranking=ranked.map((u,i)=>{const val=Math.round(u.stats[stat]),idx=this.units.indexOf(u),pct=val/totalAll*100;return `<div class="enc-rank ${idx===this.encounterView.unit?'active':''}" data-enc-unit="${idx}"><span class="enc-rank-bar ${healing?'heal':u.team==='ally'?'ally':''}" style="width:${val/max*100}%"></span><span class="enc-rank-num">${i+1}.</span><span class="enc-rank-name">${classIcon(u.cls,u.info.badge)} ${u.name}</span><span class="enc-rank-value">${val.toLocaleString()}<small>${pct.toFixed(1)}%</small></span></div>`;}).join('');panel.innerHTML=`<div class="enc-card glass"><div class="enc-head"><div class="enc-title"><div class="enc-portrait">${classIcon(selected.cls,selected.info.badge)}</div><div><h2>Encounter Details</h2><p>${status} · ${fmt(this.time)} · ${this.mode.toUpperCase()} ARENA</p></div></div><button class="enc-close" data-enc-close aria-label="Close">×</button></div><div class="enc-tabs"><button class="enc-tab ${!healing?'active':''}" data-enc-mode="damage">Damage Done</button><button class="enc-tab ${healing?'active':''}" data-enc-mode="healing">Healing Done</button></div><div class="enc-body"><section class="enc-panel"><div class="enc-panel-title">${title} per Player <span>total ${Math.round(totalAll).toLocaleString()}</span></div><div class="enc-scroll">${ranking}</div></section><section class="enc-panel"><div class="enc-panel-title">${classIcon(selected.cls,selected.info.badge)} ${selected.name} — Abilities <span>${Math.round(selectedTotal).toLocaleString()}</span></div><div class="enc-scroll">${this.encounterBreakdownRows(abilityMap,selectedTotal,mode,true)}</div></section><section class="enc-panel"><div class="enc-panel-title">${healing?'Healing Recipients':'Damage Targets'} <span>${selected.info.short}</span></div><div class="enc-scroll">${this.encounterBreakdownRows(targetMap,selectedTotal,mode)}</div><div class="enc-summary"><div class="enc-stat">Interrupts<b>${selected.stats.interrupts}</b></div><div class="enc-stat">Killing Blows<b>${selected.stats.kb}</b></div><div class="enc-stat">Enemy Defeated<b>${enemyDeaths}</b></div><div class="enc-stat">Ally Defeated<b>${allyDeaths}</b></div></div></section></div><div class="enc-foot"><span>Selected: <b>${selected.name}</b> · ${title} · Click any player or tab to inspect the encounter.</span><button class="enc-back" data-enc-close>${this.phase==='ended'?'Return to Result':'Return to Arena'}</button></div></div>`;panel.querySelectorAll('.enc-scroll').forEach((s,idx)=>{
  const desired=idx===activeScrollIndex?(previousScroll[idx]||0):(previousScroll[idx]||0);
  if(desired)s.scrollTop=desired;
  s.addEventListener('wheel',e=>{
   e.preventDefault();e.stopPropagation();
   s.scrollTop+=e.deltaY;
   this.encounterScrollActive=idx;
   this.encounterScrollTops=this.encounterScrollTops||{};
   this.encounterScrollTops[idx]=s.scrollTop;
  },{passive:false});
  s.addEventListener('pointerdown',()=>{this.encounterScrollActive=idx;},true);
 });
 requestAnimationFrame(()=>{panel.querySelectorAll('.enc-scroll').forEach((s,idx)=>{const val=this.encounterScrollTops?.[idx]??previousScroll[idx]??0;if(val)s.scrollTop=val;});});
 panel.onpointerdown=e=>{const close=e.target.closest('[data-enc-close]');if(close){e.preventDefault();e.stopPropagation();this.closeEncounterDetails();return;}const tab=e.target.closest('[data-enc-mode]');if(tab){e.preventDefault();this.encounterScrollTops={};this.encounterScrollActive=-1;this.encounterView.mode=tab.dataset.encMode;const newStat=this.encounterView.mode==='healing'?'healing':'damage';this.encounterView.unit=this.units.indexOf(this.units.slice().sort((a,b)=>b.stats[newStat]-a.stats[newStat])[0]);this.updateEncounterDetails();return;}const row=e.target.closest('[data-enc-unit]');if(row){e.preventDefault();this.encounterScrollTops={0:this.encounterScrollTops?.[0]||0};this.encounterScrollActive=-1;this.encounterView.unit=+row.dataset.encUnit;this.updateEncounterDetails();}};panel.querySelectorAll('[data-enc-unit]').forEach(row=>{row.onclick=e=>{e.preventDefault();e.stopPropagation();this.encounterScrollTops={0:this.encounterScrollTops?.[0]||0};this.encounterScrollActive=-1;this.encounterView.unit=+row.dataset.encUnit;this.updateEncounterDetails();};});}
 updateDetailsReport(){if(this.encounterView)this.updateEncounterDetails();}
 updateDetailsVisibility(){const hide=!!progression.settings?.hideLiveDetails&&(this.phase==='fight'||this.phase==='countdown');['#detailsMeter','#healingMeter'].forEach(selector=>$(selector)?.classList.toggle('hidden',hide));}
 updateDetailsMeter(){this.updateDetailsVisibility();const now=performance.now();const interval=this.mode==='3v3'&&this.phase==='fight'?100:50;if(now<(this.detailsFrameAt||0))return;this.detailsFrameAt=now+interval;this.renderMeter($('#detailsList'),'damage','damage');this.renderMeter($('#healingList'),'healing','healing');if(this.encounterView)this.updateEncounterDetails();}
  updateUtilityUI(){if(!this.player)return;const tr=$('#trinketBtn'),mt=$('#mountBtn'),u=this.player;if(!tr||!mt)return;$('#trinketKey').textContent=keyLabel(binds.trinket);$('#mountKey').textContent=keyLabel(binds.mount);const trCd=Math.max(0,u.trinketCd||0);tr.classList.toggle('oncd',trCd>0);tr.classList.toggle('disabled',trCd>0||!u.alive);tr.querySelector('.u-cd').textContent=trCd>0?Math.ceil(trCd):'';tr.title=trCd>0?`Gladiator's Medallion — Ready in ${Math.ceil(trCd)}s`:`Gladiator's Medallion — Ready (${bindLabel(binds.trinket)})`;const activeMount=mountDefinition(progression.activeMount);mt.querySelector('.u-icon').textContent=activeMount.icon;mt.querySelector('.u-title').textContent=activeMount.name.split(' ')[0];const combat=this.isInCombat(u),mounting=!!(u.cast&&u.cast.special==='mount');$('#mountState').textContent=u.mounted?'Dismount':mounting?'Casting…':combat?'In Combat':'1.5s Cast';mt.classList.toggle('disabled',!u.mounted&&(combat||mounting||!u.alive));mt.classList.toggle('active',u.mounted);mt.classList.toggle('casting',mounting);mt.title=u.mounted?`${activeMount.name} — Dismount (${bindLabel(binds.mount)})`:mounting?`Summoning ${activeMount.name}…`:combat?`${activeMount.name} — Cannot mount in combat`:`${activeMount.name} — 1.5s cast (${bindLabel(binds.mount)})`;}
 previewAbilityRange(i,a){
  if(this.player?.cls==='wind'&&i===1&&!this.player.has('cloudstepDashCd'))return 17;
  if(this.player?.cls==='wind'&&i===2&&!!this.player.has('furyReady'))return 5.0;
  return a.range||0;
 }
 previewAbilityTarget(a){
  if(!this.player)return null;
  let target=this.target;
  const self=['buff','dash','defensive','shieldSelf','push','healerEscape','monkDefensive','ghanir','flameNova','paladinAoE','paladinGuard','paladinSteed','avengingWings','iceBlock','reflect','shout','warriorGuard','sharpenBlade','avatar','combustion','flameShield','evasion','cloak','totemMastery','healingStreamTotem','stormkeeper','tigereyeBrew','karma','bladestorm','tigersLust'].includes(a.type);
  const friendly=['heal','hot','shield','spiritBlossom','ironbark','bigHeal','cleanse','freedom','guardianAngel','holyLight','sacrifice','intercept','bestowFaith','discShield','discMend','painSuppression'].includes(a.type);
  if(self)return null;
  if(a.type==='holyShock'){if(!target||!target.alive)target=this.player;}
  else if(friendly){if(!target||target.team!==this.player.team||!target.alive)target=a.type==='intercept'?this.units.filter(u=>u.team===this.player.team&&u!==this.player&&u.alive).sort((x,y)=>x.hp/x.maxHp-y.hp/y.maxHp)[0]||this.player:this.player;}
  else if(!target||target.team===this.player.team||!target.alive)target=this.closestEnemy(this.player);
  return target;
 }
 abilityOutOfRange(i,a){
  const range=this.previewAbilityRange(i,a),target=this.previewAbilityTarget(a);
  return !!(range&&target&&target!==this.player&&dist(this.player,target)>range);
 }
 applyStealthVisibility(){
   if(!this.player)return;
   this.units.forEach(u=>{
    const stealthed=!!u.has('stealth');
    const hostile=u.team!==this.player.team;
    const hidden=stealthed&&hostile;
    u.mesh.visible=!hidden&&u.alive;
    if(u.plate)u.plate.classList.toggle('stealthed',stealthed);
   });
  }
  updateNameplatePositions(){if(!this.player||this.phase==='menu'||!this.units.length)return;const now=performance.now(),cameraTurning=!!this.cameraRig?.dragging,refreshStack=cameraTurning||now>=(this.nextNameplateStackAt||0);this.units.forEach(u=>{this.toScreen(u);if(refreshStack){u._plateStackY=0;u.plate?.classList.remove('auto-stacked');}});if(refreshStack){this.nextNameplateStackAt=now+50;if(!cameraTurning&&progression.settings?.stackingNameplates!==false){const hostile=this.units.filter(u=>u.team!==this.player.team&&u.alive).map(u=>({u,p:u._screenPoint})).sort((a,b)=>a.p.y-b.p.y),groups=[];hostile.forEach(item=>{const group=groups.find(g=>g.some(other=>Math.abs(other.p.x-item.p.x)<118&&Math.abs(other.p.y-item.p.y)<64));if(group)group.push(item);else groups.push([item]);});groups.filter(group=>group.length>1).forEach(group=>{group.sort((a,b)=>a.p.y-b.p.y);const bottomY=Math.max(...group.map(item=>item.p.y));group.forEach((item,i)=>{item.u._plateStackY=bottomY-i*58-item.p.y;item.u.plate?.classList.add('auto-stacked');});});}}const pixelRatio=Math.max(1,this.lastRenderRatio||devicePixelRatio||1);this.units.forEach(u=>{const p=u._screenPoint;if(!p||!u.plate)return;const x=Math.round(p.x*pixelRatio)/pixelRatio,y=Math.round((p.y+(u._plateStackY||0))*pixelRatio)/pixelRatio;u.plate.style.transform=`translate3d(${x}px,${y}px,0) translate(-50%,-100%)`;});}
  updateUI(){if(this.phase==='menu')return;const hudNow=performance.now(),hudInterval=this.mode==='3v3'?25:16;if(hudNow<(this.nextHudFrameAt||0))return;this.nextHudFrameAt=hudNow+hudInterval;this.applyStealthVisibility?.();this.updateTotemMasteryVisuals?.();this.updateCombustionVisuals?.();const richHud=hudNow>=this.nextHudRichUpdate;if(richHud){this.nextHudRichUpdate=hudNow+50;this.updateUtilityUI();this.updateDetailsMeter();}this.setHudText($('#timer'),fmt(this.time));let ally=this.units.filter(u=>u.team==='ally'&&u.alive&&!u.healingStreamTotem).length,enemy=this.units.filter(u=>u.team==='enemy'&&u.alive&&!u.healingStreamTotem).length;this.setHudText($('#allyAlive'),ally);this.setHudText($('#enemyAlive'),enemy);
  if(this.dampening>0){$('#damp').classList.remove('hidden');$('#dampValue').textContent=Math.round(this.dampening*100)+'%';}else $('#damp').classList.add('hidden');
  (this.unitFrameElements||[]).forEach(f=>{const u=this.units[+f.dataset.unit],h=u?.frameHud;if(!u||!h)return;f.classList.toggle('selected',this.target===u);f.classList.toggle('dead',!u.alive);const hpPct=(u.hp/u.maxHp*100)+'%',shieldPct=(u.shield/u.maxHp*100)+'%';this.setHudStyle(h.hp,'width',hpPct);this.setHudStyle(h.shield,'left',hpPct);this.setHudStyle(h.shield,'width',shieldPct);this.setHudText(h.bartext,`${Math.ceil(u.hp)} / ${u.maxHp}${u.shield?`  +${Math.ceil(u.shield)}`:''}`);h.resource.className='fill resource '+(u.info.resource==='energy'?'energy':'mana');this.setHudStyle(h.resource,'width',(u.resource/u.maxResource*100)+'%');this.setHudHtml(h.effects,u.effects.slice(0,5).map(e=>this.effectChip(e)).join(''));const med=h.medallion;if(med){const cd=Math.max(0,u.trinketCd||0);med.classList.toggle('used',cd>0);this.setHudHtml(med,cd>0?`<span>🏅</span><span class="trinket-time">${Math.ceil(cd)}</span>`:`<span>🏅</span><span class="ready-dot">RDY</span>`);med.title=cd>0?`Gladiator's Medallion ready in ${Math.ceil(cd)}s`:`Gladiator's Medallion ready`;}if(h.dr)this.setHudHtml(h.dr,this.frameDRMarkup(u));const ccHtml=this.ccMarkup(u);this.setHudHtml(h.cc,ccHtml);h.cc.classList.toggle('show',!!ccHtml);const visibleCast=this.visibleFrameCast(u);h.cast.classList.toggle('hidden',!visibleCast);h.cast.classList.toggle('interrupt-shielded',!!u.has('interruptWard'));if(visibleCast){this.setHudStyle(h.castFill,'width',((1-visibleCast.left/visibleCast.total)*100)+'%');this.setHudHtml(h.castLabel,this.castNameMarkup(visibleCast));}});
  this.units.forEach(u=>{const h=u.plateHud,stealth=u.has('stealth');this.setHudStyle(u.plate,'opacity',String(u.alive?((stealth&&this.player&&u.team!==this.player.team)?0:(stealth?.65:1)):0));u.plate.classList.toggle('selected',u===this.target);this.setHudHtml(h.name,`${u.isPlayer?`<span class="plate-identity">${equippedAchievementTitle()?`<span class="plate-title">${equippedAchievementTitle()}</span>`:''}<span>${u.name}</span></span>`:`<span>${u.name}</span>`}<span class="plate-class">${classIcon(u.cls,u.info.badge)} ${u.info.short}</span>`);const hpPct=(u.hp/u.maxHp*100)+'%';this.setHudStyle(h.hp,'width',hpPct);this.setHudStyle(h.shield,'left',hpPct);this.setHudStyle(h.shield,'width',(u.shield/u.maxHp*100)+'%');const visibleCast=this.visibleFrameCast(u);h.cast.classList.toggle('hidden',!visibleCast);h.cast.classList.toggle('interrupt-shielded',!!u.has('interruptWard'));if(visibleCast){this.setHudHtml(h.castHead,this.castNameMarkup(visibleCast));this.setHudStyle(h.castFill,'width',((1-visibleCast.left/visibleCast.total)*100)+'%');}const ccHtml=this.ccMarkup(u);this.setHudHtml(h.cc,ccHtml);h.cc.classList.toggle('show',u!==this.player&&!!ccHtml);});
  const tf=$('#targetFrame');if(richHud){if(this.target&&this.target.alive){const targetLos=this.target===this.player||this.arena.los(this.player,this.target);const targetCC=this.ccMarkup(this.target);tf.classList.remove('hidden');tf.classList.toggle('enemy-target',this.target.team!==this.player.team);tf.classList.toggle('blocked',!targetLos);this.target.plate.classList.toggle('los-blocked',!targetLos);const targetDR=this.drMarkup(this.target);tf.innerHTML=`<div class="uf-head"><b>${this.target.isPlayer&&equippedAchievementTitle()?`<span class=\"uf-title\">${equippedAchievementTitle()}</span>`:''}${this.target.name}</b><span class="uf-class">${classIcon(this.target.cls,this.target.info.badge)} ${this.target.info.name} <span class="role-tag">${this.target.info.role}</span></span></div><div class="target-health-row"><div class="bar"><div class="fill hp" style="width:${this.target.hp/this.target.maxHp*100}%"></div><div class="shield-fill" style="left:${this.target.hp/this.target.maxHp*100}%;width:${this.target.shield/this.target.maxHp*100}%"></div><span class="bartext">${Math.ceil(this.target.hp)} / ${this.target.maxHp}</span></div>${targetDR}</div><div class="effects">${this.target.effects.map(e=>this.effectChip(e)).join('')}</div>${this.targetCastMarkup(this.target)}${targetCC?`<div class="cc-frame show" style="position:relative;top:auto;right:auto;margin-top:7px;display:inline-flex">${targetCC}</div>`:''}<span class="los-pill ${targetLos?'':'blocked'}">${targetLos?'● IN SIGHT':'✕ LINE OF SIGHT'}</span>`;}else{tf.classList.add('hidden');tf.classList.remove('enemy-target');this.units.forEach(u=>u.plate.classList.remove('los-blocked'));}}
  if(this.player){const centerCC=centerControlState(this.player),centerAlert=$('#playerControlAlert');if(centerAlert){if(centerCC){centerAlert.innerHTML=`<div class="cc-main"><span class="icon">${centerCC.icon}</span><span class="label-wrap"><span class="label">${centerCC.label}</span><span class="cc-timer">${centerCC.time.toFixed(1)} seconds</span></span></div>`;centerAlert.classList.remove('hidden');}else centerAlert.classList.add('hidden');}document.querySelectorAll('.ability').forEach(b=>{const i=Number(b.dataset.i),slot=Number(b.dataset.slot);if(!Number.isInteger(i)||!AB[this.player.cls][i])return;let a=AB[this.player.cls][i],cd=this.player.cds[i];const natureSwiftChoice=!!this.player.has('natureSwiftness')&&['Renewal Tide','Lullaby Bloom'].includes(a.name);if(natureSwiftChoice)cd=0;const displayedBind=b.querySelector('.key');if(displayedBind)displayedBind.textContent=bindLabel(binds['a'+((Number.isInteger(slot)?slot:i)+1)]);let was=b.classList.contains('oncd');b.classList.toggle('oncd',cd>0);b.querySelector('.cd').textContent=cd>0?cd.toFixed(cd<10?1:0):'';const visibleGcd=(this.player.cls==='soul'||this.player.has('stormkeeper'))?.5:BALANCE.gcd;b.querySelector('.gcdOverlay').style.height=(this.player.gcd/visibleGcd*100)+'%';const spellLock=this.player.has('lock_'+a.school)||this.player.has('silence');const lockRemaining=spellLock?spellLock.time:0;const outOfRange=this.abilityOutOfRange(i,a);b.classList.toggle('out-of-range',outOfRange);b.classList.toggle('school-locked',!!spellLock);const lockOverlay=b.querySelector('.lock-overlay');if(lockOverlay)lockOverlay.innerHTML=spellLock?`<strong>${lockRemaining.toFixed(1)}</strong><small>${a.school} locked</small>`:'';const whirlingGate=a.type!=='whirlingDragonPunch'||((AB[this.player.cls]||[]).findIndex(spell=>spell.type==='fistsChannel')>=0&&this.player.cds[(AB[this.player.cls]||[]).findIndex(spell=>spell.type==='fistsChannel')]>0);b.classList.toggle('disabled',cd>0||this.player.resource<a.cost||!this.player.alive||!!spellLock||!whirlingGate);const furyProc=false;/* v182: Fists is no longer a Cyclone proc */const cloudstepDash=a.name==='Cloudstep Kick'&&!this.player.has('cloudstepDashCd');const meteorLance=a.name==='Ember Lance'&&!!this.player.has('meteorLance');const tempestProc=a.name==='Arc Spark'&&!!this.player.has('tempestBolts');const stormkeeperSpark=a.name==='Arc Spark'&&!!this.player.has('stormkeeper');const evisProc=a.name==='Night Slash'&&!!this.player.has('eviscerateReady');const hotStreak=a.name==='Cinder Bolt'&&!!this.player.has('instantBolt');const holyInfusion=a.name==='Holy Light'&&!!this.player.has('infusion');const empoweredSlam=a.name==='Mortal Swing'&&!!this.player.has('empoweredSwing');const warbreakerSwing=a.name==='Mortal Swing'&&!!this.player.has('warbreakerReady');const gushingWound=a.name==='Rend'&&!!this.player.has('gushingWoundReady');const victoryRushPrimed=a.name==='Victory Rush'&&!!this.player.has('victoryRushBoost');const risingSunProc=a.name==='Zephyr Palm'&&!!this.player.has('risingSunReady');const volcanicProc=a.type==='volcanicEruption'&&!!this.player.has('volcanicEruptionReady');const pandemicProc=a.name==='Pandemic Bloom'&&!!this.player.has('pandemicSurge');const radiantPenance=a.name==='Penance'&&!!this.player.has('radiantPenanceProc');const whirlingReady=a.type==='whirlingDragonPunch'&&whirlingGate&&cd<=0;b.classList.toggle('proc',whirlingReady||holyInfusion||hotStreak||cloudstepDash||meteorLance||(a.name==='Forked Current'&&!!this.player.has('overload'))||(a.name==='Viper Cut'&&!!this.player.has('venomEdge'))||(a.name==='Cyclone Barrage'&&!!this.player.has('tempestFlow'))||furyProc||tempestProc||stormkeeperSpark||evisProc||empoweredSlam||warbreakerSwing||gushingWound||victoryRushPrimed||risingSunProc||volcanicProc||pandemicProc||radiantPenance||natureSwiftChoice);b.classList.toggle('warrior-proc',empoweredSlam||warbreakerSwing||victoryRushPrimed);b.classList.toggle('victory-rush-primed',victoryRushPrimed);b.classList.toggle('gushing-proc',gushingWound);if(holyInfusion){setSpellIcon(b.querySelector('.icon'),'Holy Light','✨');b.querySelector('.aname').textContent='Infused Holy Light';}else if(hotStreak){setSpellIcon(b.querySelector('.icon'),'Hot Streak','✨');b.querySelector('.aname').textContent=`Hot Streak ×${this.player.has('instantBolt').stacks||2}`;}else if(meteorLance){setSpellIcon(b.querySelector('.icon'),'Meteor Lance','☄️');b.querySelector('.aname').textContent=`Meteor Lance ×${this.player.has('meteorLance').stacks||2}`;}else if(risingSunProc){setSpellIcon(b.querySelector('.icon'),'Rising Sun Kick','🌅');b.querySelector('.aname').textContent='Rising Sun Kick';}else if(volcanicProc){setSpellIcon(b.querySelector('.icon'),'Volcanic Eruption','🌋');b.querySelector('.aname').textContent='Volcanic Eruption READY';}else if(pandemicProc){setSpellIcon(b.querySelector('.icon'),'Pandemic Bloom','🧫');b.querySelector('.aname').textContent='Pandemic Bloom +20%';}else if(radiantPenance){setSpellIcon(b.querySelector('.icon'),'Radiant Penance','🌠');b.querySelector('.aname').textContent='Radiant Penance';}else if(natureSwiftChoice&&a.name==='Lullaby Bloom'){setSpellIcon(b.querySelector('.icon'),'Instant Lullaby Bloom','🌿');b.querySelector('.aname').textContent='Instant Lullaby Bloom';}else if(natureSwiftChoice&&a.name==='Renewal Tide'){setSpellIcon(b.querySelector('.icon'),'Swift Renewal Tide','💚');b.querySelector('.aname').textContent='Swift Renewal Tide';}else if(cloudstepDash){setSpellIcon(b.querySelector('.icon'),'Cloudstep Dash','💨');b.querySelector('.aname').textContent='Cloudstep Dash';}else if(stormkeeperSpark){const sk=this.player.has('stormkeeper');setSpellIcon(b.querySelector('.icon'),'Free Arc Spark','⚡');b.querySelector('.aname').textContent=`Free Arc Spark ${sk?.stacks||3}`;}else if(evisProc){setSpellIcon(b.querySelector('.icon'),'Eviscerate','⚔️');b.querySelector('.aname').textContent='Eviscerate';}else if(tempestProc){setSpellIcon(b.querySelector('.icon'),'Tempest Bolt','⚡');b.querySelector('.aname').textContent=`Tempest Bolt ×${this.player.has('tempestBolts').stacks||2}`;}else if(furyProc){setSpellIcon(b.querySelector('.icon'),'Fists of Fury','🥊');b.querySelector('.aname').textContent='Fists of Fury';}else if(empoweredSlam){setSpellIcon(b.querySelector('.icon'),'Empowered Mortal Swing','⚔️');b.querySelector('.aname').textContent='Pummel +30%';}else if(warbreakerSwing){setSpellIcon(b.querySelector('.icon'),'Warbreaker Swing','🪓');b.querySelector('.aname').textContent='Warbreaker Swing';}else if(victoryRushPrimed){setSpellIcon(b.querySelector('.icon'),'Victory Rush','🏆');b.querySelector('.aname').textContent='Victory Rush +60%';}else if(gushingWound){setSpellIcon(b.querySelector('.icon'),'Gushing Wound','🩸');b.querySelector('.aname').textContent='Gushing Wound';}else{setSpellIcon(b.querySelector('.icon'),a.name,a.icon);b.querySelector('.aname').textContent=a.name;}if(was&&cd<=0){b.classList.remove('ready');void b.offsetWidth;b.classList.add('ready');}});let cw=$('#castWrap');cw.style.display=this.player.cast?'block':'none';if(this.player.cast){$('#castProgress').style.width=((1-this.player.cast.left/this.player.cast.total)*100)+'%';$('#castLabel').textContent=this.player.cast.a.name;}}
  document.querySelectorAll('.ability').forEach(button=>{const index=Number(button.dataset.i),ability=AB[this.player?.cls]?.[index];if(ability?.type==='volcanicEruption'&&!this.player.has('volcanicEruptionReady')){button.classList.add('disabled','volcanic-locked');button.classList.remove('proc');}else button.classList.remove('volcanic-locked');});
  if(richHud&&!tf.classList.contains('hidden')&&progression.settings?.showTargetOfTarget!==false&&this.target){const selected=this.target;const selectedTarget=selected.ai?.focus||(selected.netFocusId?this.units.find(unit=>String(unit.netId)===String(selected.netFocusId)):null)||selected.cast?.target||null;if(selectedTarget&&selectedTarget.alive&&selectedTarget!==selected){tf.insertAdjacentHTML('beforeend',`<div class="target-of-target"><span class="tot-portrait">${classIcon(selectedTarget.cls,selectedTarget.info?.badge||'✦')}</span><span>Targeting<strong>${selectedTarget.name}</strong></span></div>`);}}
  const protectedCenterCast=$('#castWrap');if(protectedCenterCast){const warded=!!(this.player?.cast&&this.player?.has('interruptWard'));protectedCenterCast.classList.toggle('interrupt-shielded',warded);if(warded&&$('#castLabel'))$('#castLabel').textContent=`🛡 ${this.player.cast.a.name}`;}
  if(!$('#debug').classList.contains('hidden'))this.updateDebug();
 }
 jumpPlayer(){const p=this.player;if(!p||!p.alive||p.jumpY>0||p.jumpVel!==0||p.has('furyStun')||p.has('cheapStun')||p.has('stun')||p.has('poly')||p.has('sleep')||p.has('gouge')||p.has('blind')||p.has('windIncap')||p.has('fear')||p.has('iceBlock')||p.has('root'))return false;if(p.cast&&!p.cast.moveCast){p.cast=null;this.message('Cast cancelled by movement');}p.jumpY=.01;p.jumpVel=p.mounted?5.25:5.75;this.vfxRing(p,p.mounted?0x87efff:COLORS.ally,.58);return true;}
 movementVector(){const fw=(this.keys[binds.forward]?1:0)-(this.keys[binds.backward]?1:0),rt=(this.keys[binds.right]?1:0)-(this.keys[binds.left]?1:0);const y=this.cameraRig.yaw;return{x:(-Math.sin(y))*fw+Math.cos(y)*rt,z:(-Math.cos(y))*fw-Math.sin(y)*rt};}
 playerMove(dt){if(this.player)this.player.intent=this.localMoveIntent();this.units.forEach(u=>{if((u===this.player||u.netControlled)&&u.intent)this.unitMoveByIntent(u,dt);});}
 localMoveIntent(){const v=this.movementVector(),l=Math.hypot(v.x,v.z);if(!l)return null;return {x:v.x/l,z:v.z/l};}
 unitMoveByIntent(u,dt){if(!u||!u.alive||u.has('furyStun')||u.has('cheapStun')||u.has('stun')||u.has('poly')||u.has('sleep')||u.has('gouge')||u.has('blind')||u.has('windIncap')||u.has('fear')||u.has('iceBlock')||u.has('root'))return;if(u.cast&&u.cast.channel&&!u.cast.moveCast)return;const v=u.intent;if(!v)return;if(u.cast&&!u.cast.moveCast){u.cast=null;if(u===this.player)this.message('Cast cancelled by movement');}let slow=u.has('slow')?.pct||0;/* Tiger's Lust is already included in Character.moveSpeed; do not multiply it twice. */const castMove=u.cast?.moveSpeedMult||1;u.x+=v.x*u.moveSpeed*(1-slow)*castMove*dt;u.z+=v.z*u.moveSpeed*(1-slow)*castMove*dt;if(!u.has('bladestorm'))u.mesh.rotation.y=Math.atan2(v.x,v.z);if(u===this.player)this.cameraRig.facingYaw=Math.atan2(-v.x,-v.z);this.arena.constrain(u);}
 openPauseMenu(){if(this.phase==='menu')return;this.keys={};this.paused=this.netSession?this.paused:true;$('#pauseMenu').classList.remove('hidden');}
 closePauseMenu(resume=true){$('#pauseMenu').classList.add('hidden');if(resume)this.paused=false;}
 openSettings(pause){this.paused=!!pause;this.renderBindSettings();this.saveFocusCasts();$('#settings').classList.remove('hidden');$('#closeSettings').textContent=pause?'Resume':'Close';$('#settings .settings-card h2').textContent='Keybinds & Controls';}
 closeSettings(){this.awaitBind=null;this.awaitFocusBind=null;$('#settings').classList.add('hidden');this.paused=false;}
 renderBindSettings(){const abilityActions=Array.from({length:16},(_,i)=>['a'+(i+1),'Ability '+(i+1)+(i>=7?' / Extra Toolkit':'')]);const actions=[['forward','Move Forward'],['backward','Move Backward'],['left','Strafe Left'],['right','Strafe Right'],['jump','Jump'],...abilityActions,['trinket',"Gladiator's Medallion"],['mount','Summon Mount'],['enemy','Next Enemy'],['ally','Next Ally'],['mobility','Mobility Ability Shortcut'],['pause','Settings / Pause']];$('#bindGrid').innerHTML=actions.map(a=>`<button class="bind" data-bind="${a[0]}"><span>${a[1]}</span><strong>${bindLabel(binds[a[0]])}</strong></button>`).join('');document.querySelectorAll('.bind').forEach(x=>x.onclick=()=>{this.awaitFocusBind=null;this.awaitBind=x.dataset.bind;document.querySelectorAll('.bind').forEach(b=>b.classList.toggle('waiting',b===x));document.querySelectorAll('.focus-bind-btn').forEach(b=>b.classList.remove('waiting'));x.querySelector('strong').textContent='Press key…';});this.renderFocusSettings();}
 focusEligibleAbilities(cls){const selfOnly=['buff','dash','defensive','shieldSelf','push','healerEscape','monkDefensive','iceBlock','natureSwiftness','ghanir','ultimateRadiance','discFade','discFear','archangel','darkArchangel','angelicBody','paladinGuard','paladinSteed'];const normallyBlocked=['heal','hot','shield','spiritBlossom','ironbark','bigHeal','cleanse',...selfOnly];const blocked=cls==='sage'?selfOnly:normallyBlocked;return AB[cls].map((a,i)=>({a,i})).filter(x=>!blocked.includes(x.a.type));}
 renderFocusSettings(preferred=null,preferredAbility=null){const classSelect=$('#focusClassSelect'),abilitySelect=$('#focusAbilitySelect');if(!classSelect||!abilitySelect)return;const active=preferred||classSelect.value||(this.player?this.player.cls:$('#classSelect').value);classSelect.innerHTML=Object.keys(CLASS_INFO).map(cls=>`<option value="${cls}" ${cls===active?'selected':''}>${CLASS_INFO[cls].name}</option>`).join('');classSelect.onchange=()=>this.renderFocusSettings(classSelect.value);const cls=classSelect.value,abilities=this.focusEligibleAbilities(cls),classPreview=$('#focusClassPreview');if(classPreview)classPreview.innerHTML=classIcon(cls,CLASS_INFO[cls].badge);let chosen=preferredAbility??this.focusViewAbility[cls]??DEFAULT_FOCUS_ABILITY[cls]??abilities[0]?.i??0;if(!abilities.some(x=>x.i===+chosen))chosen=abilities[0]?.i??0;chosen=+chosen;this.focusViewAbility[cls]=chosen;abilitySelect.innerHTML=abilities.map(x=>`<option value="${x.i}" ${x.i===chosen?'selected':''}>${x.a.name}</option>`).join('');abilitySelect.onchange=()=>{this.focusViewAbility[cls]=+abilitySelect.value;this.renderFocusSettings(cls,+abilitySelect.value);};const ability=AB[cls][chosen],abilityPreview=$('#focusAbilityPreview'),macros=getFocusCasts(cls,chosen),targetLabel=this.focusTargetMode(ability)==='ally'?'Ally':'Enemy';if(abilityPreview)abilityPreview.innerHTML=abilityIcon(ability);$('#focusBindGrid').innerHTML=macros.map((m,i)=>`<div class="focus-row"><span class="focus-enemy">${targetLabel} ${i+1}</span><span class="focus-action-summary"><strong>${abilityIcon(ability)}</strong>${ability.name}</span><button class="focus-bind-btn" data-focus-key="${i}">${comboLabel(m.key)}</button><button class="focus-clear" data-focus-clear="${i}" title="Clear binding">×</button></div>`).join('');$('#focusBindGrid').querySelectorAll('.focus-bind-btn').forEach(b=>b.onclick=()=>{this.awaitBind=null;this.awaitFocusBind={cls,ability:chosen,index:+b.dataset.focusKey};document.querySelectorAll('.bind').forEach(x=>x.classList.remove('waiting'));document.querySelectorAll('.focus-bind-btn').forEach(x=>x.classList.toggle('waiting',x===b));b.textContent='Press bind…';});$('#focusBindGrid').querySelectorAll('.focus-clear').forEach(b=>b.onclick=()=>{macros[+b.dataset.focusClear].key='';this.saveFocusCasts();this.renderFocusSettings(cls,chosen);});}
 assignBind(code){let old=Object.entries(binds).find(([k,v])=>v===code&&k!==this.awaitBind);if(old){let oldCode=binds[this.awaitBind];binds[old[0]]=oldCode;}binds[this.awaitBind]=code;this.awaitBind=null;this.saveBinds();this.renderBindSettings();this.renderActions();}
 assignFocusBind(combo){if(!this.awaitFocusBind)return;const {cls,ability,index}=this.awaitFocusBind,macros=getFocusCasts(cls,ability),all=ensureFocusClass(cls);Object.values(all).forEach(rows=>rows.forEach(m=>{if(m.key===combo)m.key='';}));macros[index].key=combo;this.awaitFocusBind=null;this.saveFocusCasts();this.renderFocusSettings(cls,ability);}
 saveFocusCasts(){localStorage.setItem('aetherFocusCasts',JSON.stringify(focusCasts));}
 updateDebug(){if(!this.player)return;let los=this.target?this.arena.los(this.player,this.target):false;$('#debugPanel').innerHTML=`<b>Debug / Balance Console</b><div>Target: ${this.target?.name||'None'} · Distance: ${this.target?dist(this.player,this.target).toFixed(1):'-'} · LoS: ${los?'Yes':'No'}</div><div>Dampening: ${Math.round(this.dampening*100)}% · Combat: ${this.isInCombat(this.player)?'Yes':'No'} · Mounted: ${this.player.mounted?'Yes':'No'} · Medallion: ${this.player.trinketCd>0?Math.ceil(this.player.trinketCd)+'s':'Ready'}</div><div class="debug-buttons"><button onclick="game.start()">Restart</button><button onclick="game.time=65">Force Dampening</button><button onclick="game.units.forEach(u=>u.stats={damage:0,healing:0,absorb:0,interrupts:0,kb:0})">Reset Stats</button></div>${this.units.map(u=>`<div><b style="color:${u.team==='ally'?'#36d6dc':'#f25172'}">${u.name}</b> ${Math.ceil(u.hp)}/${u.maxHp} · ${Math.floor(u.resource)} ${u.info.resource}<br>${u.effects.map(e=>effectMeta(e.type).label+'('+Math.ceil(e.time)+')').join(', ')||'No effects'}</div>`).join('<hr style="border-color:rgba(255,255,255,.08)">')}<h4>Recent Events</h4>${this.logs.map(x=>`<div class="log-line">${x}</div>`).join('')}`;}
 finish(won){if(this.phase==='ended'||this.finishPending)return;this.units.forEach(u=>{u.cast=null;u.ai?.stopMove?.();});this.finishPending=true;this.phase='ended';this.audio.play(won?'victory':'defeat');this.pendingFinishWon=won;this.finishTimer=setTimeout(()=>{this.finishTimer=null;if(this.finishPending&&this.phase==='ended'&&this.pendingFinishWon===won){try{this.finaliseFinish(won);}catch(e){console.error('Finish screen failed',e);this.finishPending=false;this.showFinishFallback(won,e);}}},96);}
 showFinishFallback(won,e=null){
 const o=$('#overlay');
 if(!o)return;
 const tournament=this.queueType==='tournament'&&this.tournament?.active;
 const bracket=tournament?this.renderTournamentBracketHTML(true):'';
 o.innerHTML=`<div class="result glass progression-result ${tournament?'tournament-result':''}"><h2 class="${won?'victory':'defeat'}">${won?'VICTORY':'DEFEAT'}</h2><p style="color:var(--muted)">Match completed. The finish screen recovered after an internal result error.</p>${bracket}<div class="reward-drop no-drop">${tournament?'Tournament state has been preserved. Use View Bracket or Menu to continue/restart.':'Progression state has been preserved where possible.'}</div><div class="menu-actions result-actions"><button class="main-btn" onclick="game.openEncounterDetails('damage',game.units.indexOf(game.player))">Match Details</button>${tournament?`<button class="minor-btn" onclick="game.openTournament()">View Bracket</button>`:`<button class="minor-btn" onclick="game.start()">Rematch</button>`}<button class="minor-btn" onclick="game.returnMenu()">Menu</button></div></div>`;
 o.classList.remove('hidden');
}
 finaliseFinish(won){if(!this.finishPending)return;this.finishPending=false;const reward=this.awardProgression(won);if(this.queueType==='tournament'&&this.tournament?.active)this.recordTournamentGame(won);let pd=this.player.stats;const allyHeal=this.units.filter(u=>u.team==='ally'&&['sage','pala','disc'].includes(u.cls)).reduce((a,u)=>a+u.stats.healing,0),enemyHeal=this.units.filter(u=>u.team==='enemy'&&['sage','pala','disc'].includes(u.cls)).reduce((a,u)=>a+u.stats.healing,0);let o=$('#overlay');const queue=reward.queueType||'ranked';const tournamentFinishedText=this.tournament?.finished?(this.tournament?.eliminated?'Tournament Eliminated':(this.tournament?.champion!=null&&this.tournament?.teams?.[this.tournament.champion]?.player?'Tournament Champion':'Tournament Complete')):this.tournamentRoundName();const summaryLine=queue==='ranked'?`<span>${CLASS_INFO[reward.cls].badge} ${CLASS_INFO[reward.cls].name} ${reward.mode.toUpperCase()} <strong>${reward.gained>=0?'+':''}${reward.gained} Rating</strong></span><span>💠 <strong>+${reward.shards}</strong> Valor Shards</span>${reward.achievementShards?`<span>✨ <strong>+${reward.achievementShards.toLocaleString()}</strong> Achievement Shards</span>`:''}<span>New ${reward.mode.toUpperCase()} Rating <strong>${reward.newRating}</strong></span>`:queue==='tournament'?`<span>🏟️ <strong>${tournamentFinishedText}</strong></span><span>Series ${this.tournament?.seriesWins||0} - ${this.tournament?.seriesLosses||0}</span><span>💠 <strong>+${reward.shards}</strong> Valor Shards</span>`:queue==='skirmish'?`<span>${CLASS_INFO[reward.cls].badge} ${CLASS_INFO[reward.cls].name} ${reward.mode.toUpperCase()} <strong>Skirmish</strong></span><span>💠 <strong>+${reward.shards}</strong> Valor Shards</span><span>Rating Unchanged <strong>${reward.newRating}</strong></span>`:`<span>${CLASS_INFO[reward.cls].badge} ${CLASS_INFO[reward.cls].name} <strong>Training Grounds</strong></span><span>No rating or shard rewards</span><span>Practice your single-target and cleave rotation</span>`;const cupWon=queue==='tournament'&&this.tournament?.finished&&this.tournament?.champion!=null&&this.tournament?.teams?.[this.tournament.champion]?.player;const dropHtml=queue==='ranked'?(reward.drop?`<div class="reward-drop">🏆 Arena Drop: <strong>${reward.drop.name}</strong> <span>ilvl ${reward.drop.ilvl} · Added to ${CLASS_INFO[reward.drop.classKey].name} Inventory</span></div>`:(won?`<div class="reward-drop no-drop">No item dropped this victory · Ranked win drop chance: 60%.</div>`:`<div class="reward-drop no-drop">Win ranked rounds for a 60% chance to receive an item drop.</div>`)):queue==='tournament'&&cupWon?`<div class="reward-drop">🏆 Aether Cup Champion: <strong>${mountSkinPreviewDefinition(this.tournament?.rewardMountId||chronocrownMountIdForClass(this.tournament?.playerClass||reward.cls),this.tournament?.rewardSkinId||chronocrownSkinIdForClass(this.tournament?.playerClass||reward.cls)).name+' — '+(mountSkinPreviewDefinition(this.tournament?.rewardMountId||chronocrownMountIdForClass(this.tournament?.playerClass||reward.cls),this.tournament?.rewardSkinId||chronocrownSkinIdForClass(this.tournament?.playerClass||reward.cls)).skinLabel||'Colour')}</strong> <span>${this.tournament?.rewardUnlocked?'Unlocked and equipped':'Colour scheme recorded · equipped'}</span></div>`:`<div class="reward-drop no-drop">${queue==='tournament'?'Aether Cup games grant light shard progress. Use View Bracket to inspect every simulated series result.':queue==='skirmish'?'Skirmishes avoid rating swings while still granting light shard progress.':'Training mode is for pure practice and does not grant progression rewards.'}</div>`;const achievementHtml=reward.achievements&&reward.achievements.length?`<div class="reward-drop">✨ Achievements Earned: <strong>${reward.achievements.map(a=>a.name).join(', ')}</strong><span>${reward.achievementShards?`+${reward.achievementShards.toLocaleString()} Valor Shards`:''}</span></div>`:'';const tournamentBracket=queue==='tournament'?this.renderTournamentBracketHTML(true):'';const tournamentButtons=queue==='tournament'?(game.tournament?.finished?`<button class="minor-btn" onclick="game.openTournament()">View Final Bracket</button><button class="minor-btn" onclick="game.openTournament()">Start Over</button>`:`<button class="minor-btn" onclick="game.openTournament()">View Bracket</button><button class="minor-btn" onclick="game.nextTournamentMatch()">Continue Tournament</button>`):`<button class="minor-btn" onclick="game.start()">Rematch</button>`;o.innerHTML=`<div class="result glass progression-result ${queue==='tournament'?'tournament-result':''}"><h2 class="${won?'victory':'defeat'}">${won?'VICTORY':'DEFEAT'}</h2><p style="color:var(--muted)">Match completed in ${fmt(this.time)}</p><div class="stats"><div class="stat">Your Damage<strong>${Math.round(pd.damage)}</strong></div><div class="stat">Killing Blows<strong>${pd.kb}</strong></div><div class="stat">Allied Healing<strong>${Math.round(allyHeal)}</strong></div><div class="stat">Enemy Healing<strong>${Math.round(enemyHeal)}</strong></div></div><div class="reward-summary">${summaryLine}</div>${tournamentBracket}${dropHtml}${achievementHtml}<div class="menu-actions result-actions"><button class="main-btn" onclick="game.openEncounterDetails('damage',game.units.indexOf(game.player))">Match Details</button><button class="minor-btn" onclick="game.openArmoury('${reward.cls}')">Armoury</button>${tournamentButtons}<button class="minor-btn" onclick="game.returnMenu()">Menu</button></div></div>`;o.classList.remove('hidden');(reward.achievements||[]).forEach(a=>this.queueAchievementToast(a));this.refreshMenuProgress();}
 returnMenu(){if(this.hudEditMode)this.finishHudEdit();this.phase='menu';this.paused=false;this.forceTournamentStart=false;this.clear();this.resetPerformance();$('#pauseMenu').classList.add('hidden');$('#settings').classList.add('hidden');$('#hud').classList.add('hidden');$('#overlay').classList.add('hidden');$('#menu').classList.remove('hidden');this.selectMenuChampionPreview($('#classSelect')?.value||'flame');this.refreshMenuProgress();}
 update(dt){this.effectQueryFrame=(this.effectQueryFrame||0)+1;if(this.netGuest){if(this.netSession)this.netSession.guestFrame(dt);}else{if(this.phase==='countdown'&&!this.paused){this.count-=dt;if(this.count<=0){this.phase='fight';this.message('FIGHT!');}else this.message(`Begins in ${Math.ceil(this.count)}`);}
  if(this.phase==='fight'&&!this.paused){this.time+=dt;if(this.time>=BALANCE.dampStart)this.dampening=clamp((Math.floor((this.time-BALANCE.dampStart)/BALANCE.dampInterval)+1)*BALANCE.dampStep,0,BALANCE.dampCap);this.playerMove(dt);this.units.forEach(u=>u.update(dt));const aiStep=1/60;this.aiAccumulator=Math.min(.10,(this.aiAccumulator||0)+dt);let aiSteps=0;while(this.aiAccumulator>=aiStep&&aiSteps<6){this.units.forEach(u=>u.ai?.update(aiStep));this.aiAccumulator-=aiStep;aiSteps++;}this.updateSupportAttacks();const aliveAlly=this.units.some(u=>u.team==='ally'&&u.alive&&!u.healingStreamTotem),aliveEnemy=this.units.some(u=>u.team==='enemy'&&u.alive&&!u.healingStreamTotem);if(!aliveEnemy)this.finish(true);if(!aliveAlly)this.finish(false);}if(this.netSession)this.netSession.hostFrame(dt);}
  this.effects.forEach(e=>{e.life-=dt;if(e.update)e.update(dt);if(e.follow&&!e.follow.alive)e.dead=true;});this.effects=this.effects.filter(e=>{if(e.life<=0||e.obj.dead||e.dead){this.scene.remove(e.obj);this.queueDispose(e.obj);return false;}return true;});const fxCap=this.mode==='3v3'?96:190;if(this.effects.length>fxCap){const extra=this.effects.splice(0,this.effects.length-fxCap);extra.forEach(e=>{if(e.obj){this.scene.remove(e.obj);this.queueDispose(e.obj);}});}
  this.updateUI();}
 updateCamera(dt){if(!this.player||this.phase==='menu')return;const r=this.cameraRig,focus=new THREE.Vector3(this.player.visualX??this.player.x,1.35,this.player.visualZ??this.player.z);const planar=Math.cos(r.pitch)*r.distance;const desired=new THREE.Vector3(focus.x+Math.sin(r.yaw)*planar,focus.y+Math.sin(r.pitch)*r.distance+1.25,focus.z+Math.cos(r.yaw)*planar);if(progression.settings?.instantCamera!==false)this.camera.position.copy(desired);else this.camera.position.lerp(desired,1-Math.pow(.0005,dt));this.camera.lookAt(focus.x,focus.y+.2,focus.z);}
 animate(){
  requestAnimationFrame(()=>this.animate());const frameStart=performance.now(),now=frameStart;
  const elapsed=Math.min(.20,Math.max(0,(now-(this.lastLoopAt||now))/1000));this.lastLoopAt=now;
  if(document.hidden){this.simulationAccumulator=0;this.aiAccumulator=0;this.lastVisualAt=now;this.lastRenderedAt=now;return;}
  const active=this.phase!=='menu';
  if(active){this.simulationAccumulator=0;this.update(Math.min(.04,elapsed));}else this.simulationAccumulator=0;
  this.lastVisualAt=now;
  const visualDt=Math.min(.05,Math.max(0,(now-(this.lastRenderedAt||now))/1000));this.lastRenderedAt=now;this.visualFrame++;
  if(active){
   this.updateCamera(visualDt);
   // Camera shake is part of the rendered view, so apply it before both the
   // WebGL render and the world-label projection.
   if(this.shake>0){this.shake-=visualDt;this.camera.position.x+=(Math.random()-.5)*.065;this.camera.position.y+=(Math.random()-.5)*.04;}
   // renderer.render refreshes camera.matrixWorldInverse. Projecting DOM
   // nameplates before this point used the previous frame's camera matrix,
   // which made names and health bars visibly trail during quick turns.
   this.renderer.render(this.scene,this.camera);
   this.updateNameplatePositions();
  }
  else{this.updateMenuChampionPreview(visualDt);this.updateGuidePreview(visualDt);this.updateArmouryPreview(visualDt);}
  this.recordFps(now,performance.now()-frameStart);
 }
}

// The mount journal keeps native-refresh motion on healthy machines and only
// reduces its refresh rate after the workload-based recovery tiers engage.
Game.prototype.animateMountPreview=function(){
 if(this.mountPreviewAnimating)return;this.mountPreviewAnimating=true;let last=0;
 const draw=now=>{if(!this.mountPreviewAnimating||$('#mountJournal').classList.contains('hidden')){this.mountPreviewAnimating=false;return;}requestAnimationFrame(draw);if(document.hidden)return;const dt=Math.min(.05,Math.max(0,(now-(last||now))/1000));last=now;const canvas=$('#mountPreviewCanvas');this.resizePreviewRenderer(this.mountPreviewRenderer,this.mountPreviewCamera,canvas,'mount');if(this.mountPreviewModel){if(!this.mountPreviewDragging)this.mountPreviewYaw+=dt*.36;this.mountPreviewModel.rotation.y=this.mountPreviewYaw;const legs=this.mountPreviewModel.userData.legs||[];legs.forEach((leg,i)=>leg.rotation.x=(i%2?1:-1)*Math.sin(now*.004)*.14);if(this.mountPreviewModel.userData.ring)this.mountPreviewModel.userData.ring.rotation.z+=dt*.48;if(this.mountPreviewModel.userData.tickFX)this.mountPreviewModel.userData.tickFX(now*.001,dt);}this.mountPreviewRenderer.render(this.mountPreviewScene,this.mountPreviewCamera);};
 requestAnimationFrame(draw);
};

// Runtime extensions are kept outside the large combat switch so the new destructible
// summon and first-hit Lightning Rod setup remain isolated and easy to validate.
Game.prototype.vfxChaosBolt=function(caster,target,onHit){
 if(!caster?.alive||!target?.alive||!this.scene)return;
 const root=new THREE.Group(),green=0x61ff20,acid=0xb5ff45;
 const coreMat=new THREE.MeshStandardMaterial({color:0x6dff26,emissive:green,emissiveIntensity:2.8,transparent:true,opacity:.96,roughness:.18,metalness:.08});
 const darkMat=new THREE.MeshStandardMaterial({color:0x050908,emissive:0x17300b,emissiveIntensity:.6,transparent:true,opacity:.84,roughness:.82,depthWrite:false});
 const core=new THREE.Mesh(new THREE.SphereGeometry(.46,12,9),coreMat);core.scale.set(.95,.78,2.55);root.add(core);
 for(let i=0;i<5;i++){const shell=new THREE.Mesh(new THREE.TorusGeometry(.52+i*.055,.075,6,18,Math.PI*1.35),darkMat.clone());shell.rotation.set(i*.73,.42+i*.88,i*.51);shell.position.z=(i-2)*.22;root.add(shell);}
 const motes=[];for(let i=0;i<6;i++){const mote=new THREE.Mesh(new THREE.OctahedronGeometry(.055+(i%3)*.018,0),new THREE.MeshBasicMaterial({color:i%3?green:0x050505,transparent:true,opacity:.92,depthWrite:false,blending:i%3?THREE.AdditiveBlending:THREE.NormalBlending}));root.add(mote);motes.push(mote);}
 root.position.set(caster.x,1.38,caster.z);this.scene.add(root);let elapsed=0,finished=false;
 const fx={obj:root,life:2.2,update:dt=>{elapsed+=dt;if(finished||!caster.alive||!target.alive){fx.dead=true;return;}const dx=target.x-root.position.x,dy=1.25-root.position.y,dz=target.z-root.position.z,d=Math.hypot(dx,dy,dz)||.001,step=Math.min(d,18*dt);root.position.x+=dx/d*step;root.position.y+=dy/d*step;root.position.z+=dz/d*step;root.lookAt(target.x,1.25,target.z);core.scale.x=.91+Math.sin(elapsed*26)*.09;core.scale.y=.76+Math.sin(elapsed*22+1)*.08;root.children.slice(1,6).forEach((part,i)=>{part.rotation.x+=dt*(7+i);part.rotation.z+=dt*(i%2?8:-8);part.material.opacity=.64+Math.sin(elapsed*17+i)*.18;});motes.forEach((m,i)=>{const a=elapsed*(9+i*.18)+i*.91,r=.62+(i%3)*.13;m.position.set(Math.cos(a)*r,Math.sin(a*1.4)*.44,(i-3)*.22);m.material.opacity=.48+Math.abs(Math.sin(elapsed*15+i))*.44;});if(d<.72){finished=true;onHit?.();this.vfxNova(target,green,2.25,12);this.vfxGlyph(target,acid,.78);this.vfxSpiral(target,0x111111,.8);this.vfxRing(target,green,2.6);this.audio.play('shadow');fx.dead=true;}}};
 this.effects.push(fx);
};
Game.prototype.vfxCrimsonVial=function(caster,duration=10){
 if(!caster?.alive||!this.scene)return;const root=new THREE.Group(),red=0xe3294f,deep=0x721129;
 const ring=new THREE.Mesh(new THREE.RingGeometry(.78,1.02,36),new THREE.MeshBasicMaterial({color:red,transparent:true,opacity:.55,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending}));ring.rotation.x=-Math.PI/2;ring.position.y=.07;root.add(ring);
 const bottle=new THREE.Group(),glass=new THREE.MeshStandardMaterial({color:0xc9163e,emissive:red,emissiveIntensity:1.4,transparent:true,opacity:.82,roughness:.22});const body=new THREE.Mesh(new THREE.CylinderGeometry(.13,.18,.42,10),glass),neck=new THREE.Mesh(new THREE.CylinderGeometry(.065,.09,.18,9),glass.clone()),cork=new THREE.Mesh(new THREE.CylinderGeometry(.072,.072,.07,8),new THREE.MeshStandardMaterial({color:0x6b361d,roughness:1}));neck.position.y=.29;cork.position.y=.415;bottle.add(body,neck,cork);bottle.position.set(.42,1.63,-.28);bottle.rotation.z=-.42;root.add(bottle);
 const motes=[];for(let i=0;i<7;i++){const mote=new THREE.Mesh(new THREE.SphereGeometry(.045+(i%3)*.018,6,5),new THREE.MeshBasicMaterial({color:i%3?red:0xff8094,transparent:true,opacity:.82,depthWrite:false,blending:THREE.AdditiveBlending}));root.add(mote);motes.push(mote);}
 this.scene.add(root);let elapsed=0;
 this.effects.push({obj:root,life:duration+.12,follow:caster,update:dt=>{elapsed+=dt;if(!caster.alive||!caster.has('crimsonVial')){root.dead=true;return;}root.position.set(caster.x,0,caster.z);root.rotation.y=caster.mesh?.rotation?.y||0;bottle.visible=elapsed<.9;bottle.rotation.x=Math.sin(Math.min(1,elapsed/.75)*Math.PI)*-.36;ring.rotation.z+=dt*1.7;ring.material.opacity=.28+Math.sin(elapsed*6)*.16;motes.forEach((m,i)=>{const phase=(elapsed*.55+i/7)%1,a=elapsed*(2.1+(i%3)*.16)+i*Math.PI/3.5,r=.68+(i%4)*.12;m.position.set(Math.cos(a)*r,.18+phase*2.15,Math.sin(a)*r);m.scale.setScalar(.7+Math.sin(elapsed*8+i)*.24);m.material.opacity=.22+(1-phase)*.65;});}});
};
Game.prototype.currentAbilityDamagePreview=function(ability){
 const c=this.player;if(!c||!ability)return null;
 const directTypes=new Set(['damage','dot','leap','singleStun','shiv','chain','flameNova','frostShock','windlordStrike','chiBurst','monkFinisher','groundStun','stun','slow','mortalSwing','charge','rend','gushingWound','pummel','shadowInterrupt','windInterrupt','volcanicEruption','warbreaker','victoryRush','chaosBolt','immolate']);
 if(!directTypes.has(ability.type)||!Number.isFinite(Number(ability.value))||Number(ability.value)<=0)return null;
 let base=Number(ability.value),label=ability.name,target=this.target&&this.target.team!==c.team?this.target:null;
 if(label==='Viper Cut'&&c.has('venomEdge'))base+=78;
 if(label==='Garrote')base=Math.round(base*.70);
 let out=base*(c.has('burst')?1.22:1)*(c.has('smokePower')?1.10:1);
 if(c.cls==='soul')out*=.67068;
 if(c.cls==='disc')out*=1.30;
 if(c.cls==='storm')out*=.805;
 if(c.has('darkArchangel'))out*=1.30;
 if(c.has('defensive')?.damagePenalty)out*=1-c.has('defensive').damagePenalty;
 if(c.has('avatar'))out*=1.18;
 if(c.has('totemMastery'))out*=1.03;
 if(c.has('avengingWings'))out*=1+Number(c.has('avengingWings').damageBonus||0);
 if(c.cls==='shadow'&&label!=='Night Slash')out*=1.10;
 const oldTigereye=c.has('tigereye');if(oldTigereye)out*=1+Math.min(10,Number(oldTigereye.stacks||0))*.005;
 const talentMult=Number(classTalentDamageMult(c.cls,c,target,label));out*=Number.isFinite(talentMult)&&talentMult>0?talentMult:1;
 if(c.gearStats){const primary=(c.gearStats.Intellect||0)+(c.gearStats.Agility||0)+(c.gearStats.Strength||0);out*=1+Math.min(.30,(c.gearStats.Power||0)*.00038)+primary*.00014+(c.gearStats.Versatility||0)*.00018;}
 const moon=this.shadowmoonBonusStrength(c);if(moon)out*=1+moon*SHADOWMOON_STRENGTH_DAMAGE_PER_POINT;
 if(ability.type==='chaosBolt')out*=1.5*(1+this.criticalStrikeChance(c));
 return {amount:Math.max(1,Math.round(out)),critical:ability.type==='chaosBolt',empowered:label==='Viper Cut'&&!!c.has('venomEdge')};
};
Game.prototype.gearAdjustedAbilityTooltip=function(ability){
 const preview=this.currentAbilityDamagePreview(ability);if(!preview)return {description:ability.tip,note:''};
 const baseline=String(Number(ability.value)),replacement=String(preview.amount),pattern=new RegExp(`\\b${baseline.replace('.','\\.')}\\b`);
 const description=pattern.test(ability.tip)?ability.tip.replace(pattern,replacement):ability.tip;
 return {description,note:''};
};
const aetherCoreTryAbility=Game.prototype.tryAbility;
Game.prototype.tryAbility=function(caster,index,target,show=false){
 const ability=AB[caster?.cls]?.[index],stormkeeperSpark=!!(caster?.cls==='storm'&&index===0&&caster.has?.('stormkeeper'));
 if(['healingStreamTotem','crimsonVial'].includes(ability?.type))target=caster;
 const interruptsBefore=caster?.stats?.interrupts||0;
 const used=aetherCoreTryAbility.call(this,caster,index,target,show);
 if(used&&ability?.type==='soulDrain'&&caster.cast?.soulDrain){
  const quickened=target?.effects?.some(e=>e.type==='burn'&&e.label==='Immolate'&&e.source===caster&&e.time>0);
  if(quickened){caster.cast.total=1.5;caster.cast.left=Math.min(caster.cast.left,1.5);this.float(caster,'IMMOLATE · SIPHON QUICKENED','info');}
 }
 if(used&&ability?.name==='Healing Surge'&&caster.cast?.a?.name==='Healing Surge'){
  // Casted cooldowns should commit only when the heal completes. Cancelling the
  // cast by moving therefore leaves Healing Surge ready instead of wasting it.
  caster.cds[index]=0;caster.cast.commitCooldown=true;
 }
 if(used&&ability?.type==='chaosBolt'&&caster.cast?.a?.type==='chaosBolt'){
  // Like Healing Surge, an interrupted Chaos Bolt should not consume its cooldown.
  caster.cds[index]=0;caster.cast.commitCooldown=true;
 }
 if(used&&stormkeeperSpark){caster.gcd=0;if(Number.isInteger(index))caster.cds[index]=0;}
 if(used&&ability?.type==='interruptProc'&&(caster?.stats?.interrupts||0)>interruptsBefore){
  const bonus=unitTalentRank(caster,'counterheat')*3;
  if(bonus>0){this.gainMana(caster,bonus);this.float(caster,`COUNTERHEAT · +${bonus} MANA`,'heal');}
 }
 return used;
};
const aetherCoreCastFor=Game.prototype.castFor;
Game.prototype.castFor=function(unit,index,target){if(['healingStreamTotem','crimsonVial'].includes(AB[unit?.cls]?.[index]?.type))target=unit;return aetherCoreCastFor.call(this,unit,index,target);};
const aetherCoreResolve=Game.prototype.resolve;
Game.prototype.resolve=function(caster,ability,target,opts={}){
 if(ability?.type==='karma'){
  caster.effects=caster.effects.filter(e=>e.type!=='touchKarma');caster.effect('touchKarma',4,{reflectPct:.30,healPct:.50});
  this.animateAction(caster,ability);this.audio.playAbility(ability,caster);this.shieldBubble(caster,COLORS.wind,4);this.vfxOrbit(caster,COLORS.wind,1.95);this.vfxRing(caster,COLORS.wind,3.1);this.vfxKarmaMark(caster,4);this.float(caster,'TOUCH OF KARMA · 30% REDIRECT · 50% HEAL','info');return;
 }
 if(ability?.name==='Dark Pact'&&ability?.type==='shieldSelf'){
  this.animateAction(caster,ability);this.audio.playAbility(ability,caster);this.applyShield(caster,caster,caster.maxHp*.30,6);this.vfxGlyph(caster,COLORS.soul,.8);this.float(caster,'DARK PACT · 30% HEALTH SHIELD','info');return;
 }
 if(ability?.type==='freedom'){
  target=target?.alive&&target.team===caster.team?target:caster;target.effects=target.effects.filter(e=>!['slow','root','freedom'].includes(e.type));target.effect('freedom',5,{speed:1.30,source:caster});
  this.animateAction(caster,ability);this.audio.playAbility(ability,caster);this.vfxFreedomRune(target,5);this.vfxGlyph(target,0xffa63c,.9);this.float(target,'BLESSING OF FREEDOM · +30% SPEED','info');return;
 }
 if(ability?.type==='guardianAngel'){
  target=target?.alive&&target.team===caster.team?target:caster;this.animateAction(caster,ability);this.audio.playAbility(ability,caster);this.spawnGuardianAngel(caster,target,Number(ability.value)||6);return;
 }
 if(ability?.type==='healingStreamTotem'){
  this.animateAction(caster,ability);this.audio.playAbility(ability,caster);this.spawnHealingStreamTotem(caster,ability);return;
 }
 if(ability?.type==='summonInfernal'){
  this.animateAction(caster,ability);this.audio.playAbility(ability,caster);this.dropInfernal(caster,target.x,target.z,ability);return;
 }
 if(ability?.type==='crimsonVial'){
  caster.effects=caster.effects.filter(e=>e.type!=='crimsonVial');
  caster.effect('crimsonVial',10.05,{vialElapsed:0,ticks:10});
  caster.vialDrinkMotion={elapsed:0,duration:.9};
  this.animateAction(caster,ability);this.audio.playAbility(ability,caster);this.vfxCrimsonVial(caster,10);this.vfxGlyph(caster,0xef4b67,.75);this.vfxRing(caster,0x9d173e,1.55);this.float(caster,'CRIMSON VIAL · 15% OVER 10 SEC','heal');return;
 }
 if(ability?.type==='frostShock'){
  this.animateAction(caster,ability);this.audio.playAbility(ability,caster);
  const hit=this.damage(caster,target,ability.value,'Frost Shock');
  if(hit){target.effects=target.effects.filter(e=>!(e.source===caster&&e.type==='frostShockAmp'));this.applySnareDR(target,3,.25,'FROST SHOCK 25%');target.effect('frostShockAmp',8,{pct:.15,source:caster});this.vfxGlyph(target,0xa6f1ff,.62);this.float(target,'FROST MARK · ARC/FORK +15% FOR 8 SEC','info');}
  return;
 }
 if(ability?.type==='chaosBolt'){
  this.animateAction(caster,ability);this.audio.playAbility(ability,caster);this.vfxGlyph(caster,0x63ff24,.72);this.vfxChaosBolt(caster,target,()=>{if(target?.alive)this.damage(caster,target,ability.value,'Chaos Bolt');});return;
 }
 if(caster?.cls==='wind'&&ability?.name==='Rising Sun Kick')caster.windSpecialMotion={type:'backflip',elapsed:0,duration:.68};
 if(caster?.cls==='wind'&&ability?.name==='Cloudstep Kick'&&ability?.dashReady){caster.windSpecialMotion={type:'serpentKick',elapsed:0,duration:.46};this.vfxSerpentKick(caster,target,.52);}
 const result=aetherCoreResolve.call(this,caster,ability,target,opts);
 if(ability?.type==='combustion'){const effect=caster.has?.('combustion');if(effect)effect.crit=.80;}
 return result;
};
const aetherCoreCharacterUpdate=Character.prototype.update;
Character.prototype.update=function(dt){
 if(!this.game.netGuest){const vial=this.has?.('crimsonVial');if(vial&&(vial.ticks||0)>0){vial.vialElapsed=(vial.vialElapsed||0)+dt;while(vial.vialElapsed>=1&&(vial.ticks||0)>0){vial.vialElapsed-=1;vial.ticks--;const amount=Math.max(1,Math.round(this.maxHp*.015)),actual=Math.min(this.maxHp-this.hp,amount);if(actual>0){this.hp+=actual;this.stats.healing+=actual;this.stats.healingByAbility['Crimson Vial']=(this.stats.healingByAbility['Crimson Vial']||0)+actual;this.stats.healingByTarget[this.name]=(this.stats.healingByTarget[this.name]||0)+actual;this.game.float(this,actual,'heal');this.game.vfxBurst(this,0xa92552,.42);}}}}
 const result=aetherCoreCharacterUpdate.call(this,dt),motion=this.windSpecialMotion,drink=this.vialDrinkMotion;
 if(drink&&this.mesh){drink.elapsed+=dt;const p=Math.min(1,drink.elapsed/drink.duration),lift=Math.sin(p*Math.PI);if(this.armR)this.armR.rotation.x=-.85-lift*.95;if(this.armR)this.armR.rotation.z=-.18-lift*.34;if(this.handR)this.handR.position.set(.30,.82+lift*.78,-.12-lift*.34);if(this.torso)this.torso.rotation.x=-lift*.08;if(p>=1)this.vialDrinkMotion=null;}
 if(motion&&this.mesh){motion.elapsed+=dt;const p=Math.min(1,motion.elapsed/motion.duration),smooth=p*p*(3-2*p);if(motion.type==='backflip'){this.mesh.rotation.x=-Math.PI*2*smooth;this.mesh.position.y+=Math.sin(p*Math.PI)*1.42;}else{this.mesh.rotation.x=-Math.sin(p*Math.PI)*.30;this.mesh.position.y+=Math.sin(p*Math.PI)*.48;}if(p>=1){this.mesh.rotation.x=0;this.windSpecialMotion=null;}}
 return result;
};
const aetherCoreDamage=Game.prototype.damage;
Game.prototype.damage=function(source,target,value,label){
 const stormkeeperRod=label==='Stormkeeper Arc Spark',currentRod=target?.has?.('lightningRod'),firstRod=!!(source?.cls==='storm'&&stormkeeperRod&&target?.alive&&(!currentRod||currentRod.source!==source));
 const resolvedLabel=stormkeeperRod?'Arc Spark':label,frostMark=target?.has?.('frostShockAmp'),frostEmpowered=!!(source?.cls==='storm'&&frostMark?.source===source&&['Arc Spark','Forked Current'].includes(resolvedLabel));
 const infernalExposure=target?.has?.('infernalExposure'),infernalAmp=!!(infernalExposure&&infernalExposure.source?.alive!==false);
 const hit=aetherCoreDamage.call(this,source,target,value*(frostEmpowered?1.15:1)*(infernalAmp?1.10:1),resolvedLabel);
 if(hit&&target?.alive&&source?.cls==='soul'&&/^Infernal (Impact|Immolation)$/i.test(String(label||''))){target.effects=target.effects.filter(e=>!(e.type==='infernalExposure'&&e.source===source));target.effect('infernalExposure',10,{source,pct:.10});}
 if(hit&&firstRod&&target.alive)this.applyLightningRod(source,target);
 return hit;
};
Game.prototype.applyLightningRod=function(source,center){
 if(!source?.alive||!center?.alive)return;
 const marked=this.units.filter(u=>u.alive&&u.team!==source.team&&dist(u,center)<=8&&this.arena.los(center,u));
 marked.forEach((u,i)=>{u.effects=u.effects.filter(e=>!(e.type==='lightningRod'&&e.source===source));u.effect('lightningRod',6,{source});this.vfxGlyph(u,0x8deeff,.58);if(i<3)this.float(u,'LIGHTNING ROD · +20%','error');});
 this.vfxLightningRodCloud(center,6);this.log(`${source.name} created an 8m Lightning Rod cloud, marking ${marked.length} target${marked.length===1?'':'s'} for 6 sec.`);
};
Game.prototype.vfxLightningRodCloud=function(target,duration=6){
 if(!target||!this.scene)return;const root=new THREE.Group(),cloudMat=new THREE.MeshBasicMaterial({color:0x4164c9,transparent:true,opacity:.20,depthWrite:false,blending:THREE.AdditiveBlending}),arcMat=new THREE.MeshBasicMaterial({color:0xa9f5ff,transparent:true,opacity:.72,depthWrite:false,blending:THREE.AdditiveBlending});
 for(let i=0;i<5;i++){const puff=new THREE.Mesh(new THREE.SphereGeometry(.72+i*.06,10,8),cloudMat.clone());puff.scale.set(1.8,.45,1.15);puff.position.set(Math.cos(i*1.31)*1.45,4.25+Math.sin(i)*.18,Math.sin(i*1.31)*1.45);root.add(puff);}
 const ring=new THREE.Mesh(new THREE.RingGeometry(3.82,4.05,48),arcMat);ring.rotation.x=-Math.PI/2;ring.position.y=.06;root.add(ring);
 const bolt=new THREE.Mesh(new THREE.CylinderGeometry(.025,.055,3.45,6),arcMat.clone());bolt.position.y=2.15;bolt.rotation.z=.10;root.add(bolt);this.scene.add(root);let elapsed=0;
 this.effects.push({obj:root,life:duration,follow:target,update:dt=>{elapsed+=dt;root.position.set(target.x,0,target.z);ring.rotation.z+=dt*.85;bolt.visible=Math.sin(elapsed*12)>.58;root.children.slice(0,5).forEach((p,i)=>{p.position.y=4.25+Math.sin(elapsed*2.4+i)*.16;p.material.opacity=.14+Math.sin(elapsed*3+i)*.06;});}});
};
Game.prototype.vfxSerpentKick=function(source,target,duration=.52){
 if(!source||!target||!this.scene)return;const dx=target.x-source.x,dz=target.z-source.z,length=Math.hypot(dx,dz)||1,nx=-dz/length,nz=dx/length,points=[];for(let i=0;i<=7;i++){const p=i/7,wave=Math.sin(p*Math.PI*2)*.34*(1-p);points.push(new THREE.Vector3(source.x+dx*p+nx*wave,.65+Math.sin(p*Math.PI)*.62,source.z+dz*p+nz*wave));}const curve=new THREE.CatmullRomCurve3(points),mat=new THREE.MeshBasicMaterial({color:0xb9fff2,transparent:true,opacity:.62,depthWrite:false,blending:THREE.AdditiveBlending}),tube=new THREE.Mesh(new THREE.TubeGeometry(curve,28,.14,6,false),mat),head=new THREE.Group(),headMat=mat.clone();headMat.color.setHex(0x78ffd3);const skull=new THREE.Mesh(new THREE.ConeGeometry(.36,.78,6),headMat);skull.rotation.x=Math.PI/2;head.add(skull);for(const side of [-1,1]){const horn=new THREE.Mesh(new THREE.ConeGeometry(.08,.46,5),headMat.clone());horn.position.set(side*.27,.12,.04);horn.rotation.z=side*.72;head.add(horn);}head.position.copy(points[points.length-1]);head.rotation.y=Math.atan2(dx,dz);const root=new THREE.Group();root.add(tube,head);this.scene.add(root);let elapsed=0;this.effects.push({obj:root,life:duration,update:dt=>{elapsed+=dt;const opacity=Math.max(0,1-elapsed/duration);root.children.forEach(child=>{if(child.material)child.material.opacity=.62*opacity;child.children?.forEach?.(part=>{if(part.material)part.material.opacity=.68*opacity;});});head.scale.setScalar(1+Math.sin(elapsed*18)*.08);}});
};
/* Nature's Grasp: gnarled mossy roots burst from the ground and cage the target's legs,
   holding until the root breaks. Arches are half-toruses standing in the XY plane, so
   their feet sit on the ground and they peak overhead; spinning each one on Y builds a
   crossing cage rather than a flat ring. */
Game.prototype.vfxEntanglingRoots=function(target,duration=5){
 if(!target||!this.scene)return;
 const group=new THREE.Group(),rand=(a,b)=>a+Math.random()*(b-a);
 const bark=new THREE.MeshLambertMaterial({color:0x4f6329,emissive:0x1a2708,emissiveIntensity:.42});
 const moss=new THREE.MeshLambertMaterial({color:0x7fa347,emissive:0x33511a,emissiveIntensity:.55});
 const mound=new THREE.Mesh(new THREE.SphereGeometry(.78,16,8,0,Math.PI*2,0,Math.PI/2),bark);
 mound.scale.set(1,.30,1);group.add(mound);
 const arches=[];
 for(let i=0;i<5;i++){
  const r=rand(.52,.72),arch=new THREE.Mesh(new THREE.TorusGeometry(r,rand(.075,.115),6,18,Math.PI*rand(.82,1.0)),i%2?bark:moss);
  arch.rotation.y=(i/5)*Math.PI+rand(-.16,.16);
  arch.rotation.z=rand(-.22,.22);
  arch.position.set(rand(-.10,.10),-.04,rand(-.10,.10));
  group.add(arch);arches.push(arch);
 }
 const tips=[];
 for(let i=0;i<7;i++){
  const a=(i/7)*Math.PI*2+rand(-.25,.25),d=rand(.34,.56),h=rand(.55,1.05);
  const tip=new THREE.Mesh(new THREE.CylinderGeometry(rand(.028,.05),rand(.09,.14),h,5),i%3?bark:moss);
  tip.position.set(Math.cos(a)*d,h*.42,Math.sin(a)*d);
  tip.rotation.z=-Math.cos(a)*rand(.35,.62);
  tip.rotation.x=Math.sin(a)*rand(.35,.62);
  group.add(tip);tips.push(tip);
 }
 const ring=new THREE.Mesh(new THREE.RingGeometry(.62,1.05,24),new THREE.MeshBasicMaterial({color:0x9be24f,transparent:true,opacity:.30,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending}));
 ring.rotation.x=-Math.PI/2;ring.position.y=.06;group.add(ring);
 group.position.set(target.x,0,target.z);
 this.scene.add(group);
 let elapsed=0;
 this.effects.push({obj:group,life:duration+.4,follow:target,update:dt=>{
  elapsed+=dt;
  const rooted=target.alive&&target.has('root');
  if(!rooted&&elapsed>.30){group.dead=true;return;}
  const grow=Math.min(1,elapsed/.30),fade=Math.min(1,Math.max(0,(duration-elapsed)/.35));
  group.position.set(target.x,0,target.z);
  const s=grow*fade;
  group.scale.set(s,s*(.70+.30*grow),s);
  group.rotation.y+=dt*.20;
  arches.forEach((arch,i)=>{arch.rotation.z+=Math.sin(elapsed*2.1+i)*dt*.10;});
  tips.forEach((tip,i)=>{tip.rotation.y=Math.sin(elapsed*1.7+i)*.14;});
  ring.material.opacity=.30*fade*(.72+Math.sin(elapsed*4.2)*.28);
 }});
};
/* Blessing of Freedom: a burning rune circle inscribed on the ground under the blessed
   target, riding along with them for the duration. */
Game.prototype.vfxFreedomRune=function(target,duration=5){
 if(!target||!this.scene)return;
 const cv=document.createElement('canvas');cv.width=cv.height=512;const g=cv.getContext('2d');
 g.clearRect(0,0,512,512);
 g.translate(256,256);
 g.shadowColor='#ff8a1c';g.shadowBlur=26;g.strokeStyle='#ffb454';g.fillStyle='#ffd79a';
 g.lineWidth=9;g.beginPath();g.arc(0,0,232,0,Math.PI*2);g.stroke();
 g.lineWidth=5;g.beginPath();g.arc(0,0,196,0,Math.PI*2);g.stroke();
 g.lineWidth=4;g.beginPath();g.arc(0,0,120,0,Math.PI*2);g.stroke();
 g.lineWidth=3;g.beginPath();g.arc(0,0,104,0,Math.PI*2);g.stroke();
 /* runes seated in the outer band */
 const glyphs=['\u16D7','\u16A6','\u16B1','\u16C1','\u16DE','\u16A8','\u16C7','\u16E3','\u16D2','\u16B7','\u16CB','\u16DA'];
 g.font='bold 44px serif';g.textAlign='center';g.textBaseline='middle';
 glyphs.forEach((ch,i)=>{const a=i/glyphs.length*Math.PI*2;g.save();g.translate(Math.cos(a)*214,Math.sin(a)*214);g.rotate(a+Math.PI/2);g.fillText(ch,0,0);g.restore();});
 /* spokes linking the inner ring to the band */
 g.lineWidth=4;
 for(let i=0;i<8;i++){const a=i/8*Math.PI*2+.39;g.beginPath();g.moveTo(Math.cos(a)*122,Math.sin(a)*122);g.lineTo(Math.cos(a)*194,Math.sin(a)*194);g.stroke();}
 /* a simple sigil at the centre */
 g.lineWidth=6;g.beginPath();
 for(let i=0;i<6;i++){const a=i/6*Math.PI*2-Math.PI/2,x=Math.cos(a)*74,y=Math.sin(a)*74;i?g.lineTo(x,y):g.moveTo(x,y);}
 g.closePath();g.stroke();
 const tex=new THREE.CanvasTexture(cv);
 const group=new THREE.Group();
 const disc=new THREE.Mesh(new THREE.CircleGeometry(1.62,40),new THREE.MeshBasicMaterial({color:0xb457ff,transparent:true,opacity:.20,depthWrite:false,blending:THREE.AdditiveBlending}));
 disc.rotation.x=-Math.PI/2;disc.position.y=.03;group.add(disc);
 const runes=new THREE.Mesh(new THREE.PlaneGeometry(3.5,3.5),new THREE.MeshBasicMaterial({map:tex,transparent:true,opacity:.95,depthWrite:false,blending:THREE.AdditiveBlending}));
 runes.rotation.x=-Math.PI/2;runes.position.y=.06;group.add(runes);
 const rim=new THREE.Mesh(new THREE.TorusGeometry(1.58,.045,6,44),new THREE.MeshBasicMaterial({color:0xff9a3c,transparent:true,opacity:.72,depthWrite:false,blending:THREE.AdditiveBlending}));
 rim.rotation.x=-Math.PI/2;rim.position.y=.08;group.add(rim);
 group.position.set(target.x,0,target.z);
 this.scene.add(group);
 let elapsed=0;
 this.effects.push({obj:group,life:duration+.3,follow:target,update:dt=>{
  elapsed+=dt;
  if(!target.alive||(!target.has('freedom')&&elapsed>.20)){group.dead=true;return;}
  group.position.set(target.x,0,target.z);
  const grow=Math.min(1,elapsed/.22),fade=Math.min(1,Math.max(0,(duration-elapsed)/.4));
  group.scale.setScalar(grow*(.94+.06*fade));
  runes.rotation.z-=dt*.55;rim.rotation.z+=dt*.35;
  const pulse=.72+Math.sin(elapsed*4.6)*.24;
  runes.material.opacity=.95*fade;disc.material.opacity=.20*fade*pulse;rim.material.opacity=.72*fade*pulse;
 }});
};
Game.prototype.vfxKarmaMark=function(target,duration=4){
 if(!target||!this.scene)return;const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;const ctx=canvas.getContext('2d');ctx.clearRect(0,0,256,256);ctx.shadowColor='#9fffd8';ctx.shadowBlur=34;ctx.fillStyle='#eafff4';ctx.font='208px serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('☯',128,134);ctx.shadowBlur=16;ctx.fillText('☯',128,134);const texture=new THREE.CanvasTexture(canvas),sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthWrite:false}));sprite.scale.set(2.6,2.6,2.6);this.scene.add(sprite);let elapsed=0;this.effects.push({obj:sprite,life:duration,follow:target,update:dt=>{elapsed+=dt;if(!target.alive||!target.has('touchKarma')){sprite.dead=true;return;}const pulse=2.6*(1+Math.sin(elapsed*4.4)*.10);sprite.scale.set(pulse,pulse,pulse);sprite.position.set(target.x,3.95+Math.sin(elapsed*5)*.12,target.z);sprite.material.opacity=Math.max(.45,1-elapsed/duration*.30);}});
};
Game.prototype.spawnGuardianAngel=function(owner,target,duration=6){
 if(!owner?.alive||!target?.alive)return;this.units.filter(u=>u.guardianAngelSummon&&u.alive&&u.totemOwner===owner).forEach(u=>u.die(null));
 const angel=this.spawn('Guardian Val’kyr','pala',owner.team,target.x+2.5,target.z+2.1,false);angel.ai=null;angel.guardianAngelSummon=true;angel.summonedUnit=true;angel.healingStreamTotem=true;angel.totemOwner=owner;angel.protectedTarget=target;angel.maxHp=124;angel.hp=124;angel.maxResource=0;angel.resource=0;angel.moveSpeed=5.6;angel.expiresAt=this.time+duration;angel.mesh.children.forEach(child=>child.visible=false);if(angel.clickHitbox)angel.clickHitbox.visible=true;
 const visual=new THREE.Group();
 /* Val'kyr: white plate over a pale body, layered feather wings and cyan spirit light. */
 const plate=new THREE.MeshLambertMaterial({color:0xf7fbff,emissive:0x9fd9f2,emissiveIntensity:.34});
 const pale=new THREE.MeshLambertMaterial({color:0xe8f4fb,emissive:0x7fc4e4,emissiveIntensity:.22});
 const spirit=new THREE.MeshBasicMaterial({color:0x9ff2ff,transparent:true,opacity:.62,depthWrite:false,blending:THREE.AdditiveBlending});
 const feather=new THREE.MeshLambertMaterial({color:0xffffff,emissive:0xcdeeff,emissiveIntensity:.62,transparent:true,opacity:.94,side:THREE.DoubleSide});
 const featherGlow=new THREE.MeshBasicMaterial({color:0xbfeaff,transparent:true,opacity:.20,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending});
 /* body */
 const torso=new THREE.Mesh(new THREE.CapsuleGeometry(.24,.60,4,10),pale);torso.position.y=1.52;visual.add(torso);
 const chest=new THREE.Mesh(new THREE.BoxGeometry(.46,.44,.30),plate);chest.position.y=1.72;visual.add(chest);
 const belt=new THREE.Mesh(new THREE.BoxGeometry(.40,.13,.26),plate);belt.position.y=1.34;visual.add(belt);
 const skirt=new THREE.Mesh(new THREE.ConeGeometry(.34,.86,8),plate);skirt.position.y=.92;visual.add(skirt);
 for(const side of [-1,1]){
  const leg=new THREE.Mesh(new THREE.CapsuleGeometry(.09,.52,4,6),pale);leg.position.set(side*.13,.52,0);visual.add(leg);
  const boot=new THREE.Mesh(new THREE.ConeGeometry(.13,.34,6),plate);boot.position.set(side*.13,.20,.02);boot.rotation.x=Math.PI;visual.add(boot);
  const arm=new THREE.Mesh(new THREE.CapsuleGeometry(.075,.46,4,6),pale);arm.position.set(side*.32,1.50,.04);arm.rotation.z=side*.30;visual.add(arm);
  /* cyan spirit fire in each hand */
  const flame=new THREE.Mesh(new THREE.SphereGeometry(.15,10,8),spirit.clone());flame.position.set(side*.40,1.22,.08);visual.add(flame);
  /* spiked pauldron */
  const pauldron=new THREE.Mesh(new THREE.ConeGeometry(.21,.36,5),plate);pauldron.position.set(side*.34,1.88,0);pauldron.rotation.z=side*.42;visual.add(pauldron);
 }
 /* helm with a raised crest */
 const head=new THREE.Mesh(new THREE.SphereGeometry(.20,12,10),pale);head.position.y=2.12;visual.add(head);
 const helm=new THREE.Mesh(new THREE.ConeGeometry(.22,.40,6),plate);helm.position.y=2.20;visual.add(helm);
 const crest=new THREE.Mesh(new THREE.ConeGeometry(.06,.34,4),plate);crest.position.set(0,2.50,-.02);visual.add(crest);
 for(const side of [-1,1]){const horn=new THREE.Mesh(new THREE.ConeGeometry(.05,.30,4),plate);horn.position.set(side*.17,2.30,0);horn.rotation.z=side*.62;visual.add(horn);}
 /* wings: a fan of long feathers per side, each backed by a soft additive copy */
 const wings=[];
 for(const side of [-1,1]){
  const wing=new THREE.Group();
  for(let i=0;i<8;i++){
   const len=1.95-i*.16,spread=.30+i*.185;
   const quill=new THREE.Mesh(new THREE.ConeGeometry(.115,len,4),feather);
   quill.scale.set(1,1,.30);
   quill.position.set(side*spread,.16-i*.115,-.03*i);
   quill.rotation.z=side*(Math.PI/2-.34-i*.135);
   wing.add(quill);
   const halo=new THREE.Mesh(new THREE.ConeGeometry(.20,len*1.05,4),featherGlow);
   halo.scale.set(1,1,.18);halo.position.copy(quill.position);halo.position.z-=.06;halo.rotation.z=quill.rotation.z;
   wing.add(halo);
  }
  wing.position.set(side*.30,1.82,-.16);
  visual.add(wing);wings.push(wing);
 }
 /* column of spirit light rising behind her */
 const beam=new THREE.Mesh(new THREE.CylinderGeometry(.30,.46,6.4,12,1,true),new THREE.MeshBasicMaterial({color:0x8fe8ff,transparent:true,opacity:.13,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending}));
 beam.position.set(0,3.0,-.30);visual.add(beam);
 const halo=new THREE.Mesh(new THREE.TorusGeometry(.34,.030,6,24),spirit.clone());halo.rotation.x=Math.PI/2;halo.position.y=2.72;visual.add(halo);
 visual.scale.setScalar(1.18);
 angel.mesh.add(visual);angel.guardianVisual=visual;angel.effect('guardianLifetime',duration,{source:owner});target.effects=target.effects.filter(e=>e.type!=='guardianImmunity');target.effect('guardianImmunity',duration,{source:angel});
 const bubble=new THREE.Mesh(new THREE.SphereGeometry(1.18,14,10),new THREE.MeshBasicMaterial({color:0xffefaa,transparent:true,opacity:.17,wireframe:true,depthWrite:false,blending:THREE.AdditiveBlending}));this.scene.add(bubble);this.effects.push({obj:bubble,life:duration,follow:target,update:dt=>{const guard=target.has('guardianImmunity');if(!target.alive||!guard||guard.source!==angel||!angel.alive){bubble.dead=true;return;}bubble.position.set(target.x,1.15,target.z);bubble.rotation.y+=dt*.8;}});
 angel.receiveHeal=()=>{};angel.die=killer=>{if(!angel.alive)return;angel.alive=false;angel.hp=0;angel.cast=null;angel.mesh.visible=false;if(angel.plate)angel.plate.style.opacity='0';target.effects=target.effects.filter(e=>!(e.type==='guardianImmunity'&&e.source===angel));if(killer){killer.stats.kb++;this.float(angel,'VAL’KYR DESTROYED','error');this.log(`${killer.name} destroyed ${owner.name}'s Guardian Val’kyr.`);}if(this.target===angel)this.target=null;};
 angel.update=dt=>{if(!angel.alive)return;angel.effects=angel.effects.filter(e=>(e.time-=dt)>0);if(!owner.alive||!target.alive||this.time>=angel.expiresAt){angel.die(null);return;}const stunned=!!(angel.has('stun')||angel.has('furyStun')||angel.has('cheapStun'));if(!stunned){const angle=this.time*.72,tx=target.x+Math.cos(angle)*2.95,tz=target.z+Math.sin(angle)*2.95,dx=tx-angel.x,dz=tz-angel.z,d=Math.hypot(dx,dz)||1;if(d>.18){const step=Math.min(d,angel.moveSpeed*dt);angel.x+=dx/d*step;angel.z+=dz/d*step;}angel.mesh.rotation.y=Math.atan2(dx,dz);}angel.visualX=angel.x;angel.visualZ=angel.z;angel.mesh.position.set(angel.x,.62+Math.sin(this.time*3.2)*.11,angel.z);halo.rotation.z+=dt*1.8;beam.material.opacity=.10+Math.abs(Math.sin(this.time*1.6))*.06;wings.forEach((wing,i)=>{const beat=Math.sin(this.time*2.4+i*Math.PI)*.13;wing.rotation.y=beat;wing.rotation.x=Math.sin(this.time*2.4)*.07;wing.position.y=1.82+Math.sin(this.time*2.4)*.05;});};
 this.vfxGlyph(target,COLORS.holy,1.05);this.vfxRing(target,COLORS.holy,2.6);this.float(target,'GUARDIAN ANGEL · IMMUNE WHILE VAL’KYR LIVES','info');this.log(`${owner.name} summoned a 124-health Guardian Val’kyr for ${duration} sec to protect ${target.name}.`);
};
Game.prototype.dropInfernal=function(owner,x,z,ability){
 if(!owner?.alive)return;
 const holder=new THREE.Group(),warningMat=new THREE.MeshBasicMaterial({color:0x65ff20,transparent:true,opacity:.68,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending}),warning=new THREE.Mesh(new THREE.RingGeometry(.7,ability.radius||5,28),warningMat),rockMat=new THREE.MeshBasicMaterial({color:0x65d92a}),rock=new THREE.Mesh(new THREE.DodecahedronGeometry(.92,0),rockMat);
 warning.rotation.x=-Math.PI/2;warning.position.set(x,.07,z);rock.position.set(x+1.8,17,z-1.1);holder.add(warning,rock);this.scene.add(holder);let elapsed=0;
 this.effects.push({obj:holder,life:1.05,update:dt=>{elapsed+=dt;warning.material.opacity=.30+Math.abs(Math.sin(elapsed*15))*.38;warning.rotation.z+=dt*.7;rock.rotation.x+=dt*4.2;rock.rotation.z+=dt*3.1;rock.position.y-=dt*17.4;rock.position.x-=dt*1.85;rock.position.z+=dt*1.12;if(elapsed>=.92&&!holder.userData.landed){holder.userData.landed=true;const radius=ability.radius||5;this.vfxRing({x,z},0x65ff20,radius);this.vfxNova({x,z},0x258c16,3.2,8);this.vfxGlyph({x,z},0xb2ff74,.66);this.shake=Math.max(this.shake,.11);let struck=0;this.units.filter(u=>u.team!==owner.team&&u.alive&&!u.healingStreamTotem&&Math.hypot(u.x-x,u.z-z)<=radius&&this.arena.los(owner,u)).forEach(u=>{if(this.damage(owner,u,ability.value||90,'Infernal Impact')){this.applyStun(u,2);if(struck<2)this.vfxGlyph(u,0x65ff20,.48);struck++;}});this.spawnInfernal(owner,x,z,ability);this.float(owner,`INFERNAL LANDED · ${struck} STUNNED`,'info');this.log(`${owner.name}'s Infernal landed, striking ${struck} enem${struck===1?'y':'ies'} and stunning for 2 sec.`);}}});
};
Game.prototype.spawnInfernal=function(owner,x,z,ability){
 this.units.filter(u=>u.infernalSummon&&u.alive&&u.totemOwner===owner).forEach(u=>u.die(null));
 const infernal=this.spawn('Infernal','soul',owner.team,x,z,false);infernal.ai=null;infernal.infernalSummon=true;infernal.summonedUnit=true;infernal.healingStreamTotem=true;infernal.totemOwner=owner;infernal.maxHp=Math.max(1,Math.round(owner.maxHp*.25));infernal.hp=infernal.maxHp;infernal.maxResource=0;infernal.resource=0;infernal.moveSpeed=3.6;infernal.expiresAt=this.time+(ability.duration||10);infernal.nextPulseAt=this.time+2;infernal.nextManaAt=this.time+1;infernal.slamTime=0;infernal.mesh.children.forEach(child=>child.visible=false);if(infernal.clickHitbox)infernal.clickHitbox.visible=true;infernal.effect('infernalLifetime',ability.duration||10,{source:owner});
 const visual=new THREE.Group(),stone=new THREE.MeshLambertMaterial({color:0x4d5357,emissive:0x111515,emissiveIntensity:.14}),darkStone=new THREE.MeshLambertMaterial({color:0x24292b,emissive:0x10210b,emissiveIntensity:.18}),fel=new THREE.MeshLambertMaterial({color:0x71ff20,emissive:0x48ff08,emissiveIntensity:2.3}),felFx=new THREE.MeshBasicMaterial({color:0x72ff20,transparent:true,opacity:.72,depthWrite:false,blending:THREE.AdditiveBlending});
 const rock=(geometry,position,scale,material=stone,parent=visual)=>{const mesh=new THREE.Mesh(geometry,material);mesh.position.set(...position);mesh.scale.set(...scale);mesh.castShadow=false;mesh.receiveShadow=false;parent.add(mesh);return mesh;};
 const torso=rock(new THREE.DodecahedronGeometry(.92,0),[0,2.17,0],[1.15,1.20,.78],darkStone),chestCore=rock(new THREE.SphereGeometry(.47,10,8),[0,2.18,.70],[1,.88,.42],fel),chestRim=new THREE.Mesh(new THREE.TorusGeometry(.51,.13,7,14),stone);chestRim.position.set(0,2.18,.72);visual.add(chestRim);
 const head=rock(new THREE.DodecahedronGeometry(.42,0),[0,3.18,.08],[.92,.72,.82],stone),jaw=rock(new THREE.BoxGeometry(.52,.20,.38),[0,2.95,.34],[1,1,1],darkStone),eyeMat=felFx.clone();for(const side of [-1,1]){const eye=new THREE.Mesh(new THREE.SphereGeometry(.065,7,5),eyeMat);eye.position.set(side*.14,3.22,.40);visual.add(eye);}
 const armPivots=[],legPivots=[];
 for(const side of [-1,1]){
  const shoulder=rock(new THREE.DodecahedronGeometry(.74,0),[side*1.15,2.78,.02],[1.42,1.00,1.05],stone),spike=rock(new THREE.ConeGeometry(.22,.92,6),[side*1.66,3.18,.02],[1,1,1],stone);spike.rotation.z=-side*1.08;
  const arm=new THREE.Group();arm.position.set(side*1.18,2.62,0);visual.add(arm);armPivots.push(arm);const upper=rock(new THREE.DodecahedronGeometry(.47,0),[side*.12,-.48,0],[.86,1.35,.82],darkStone,arm),forearm=rock(new THREE.DodecahedronGeometry(.58,0),[side*.18,-1.18,.02],[.94,1.30,.90],stone,arm),fist=rock(new THREE.DodecahedronGeometry(.49,0),[side*.20,-1.83,-.03],[1.00,.86,1.08],stone,arm);
  const leg=new THREE.Group();leg.position.set(side*.48,1.18,0);visual.add(leg);legPivots.push(leg);rock(new THREE.DodecahedronGeometry(.48,0),[0,-.26,0],[.82,1.28,.78],darkStone,leg);rock(new THREE.DodecahedronGeometry(.62,0),[0,-1.02,-.06],[1.04,1.18,1.18],stone,leg);const foot=rock(new THREE.DodecahedronGeometry(.58,0),[0,-1.50,-.22],[1.10,.64,1.42],stone,leg);
  for(const y of [1.55,2.10]){const crack=rock(new THREE.BoxGeometry(.055,.46,.035),[side*(y<2?1.33:.67),y,.61],[1,1,1],fel);crack.rotation.z=side*(y<2?.36:-.28);}
 }
 for(const [px,py,rz,sx] of [[-.45,2.43,-.42,.70],[.35,2.55,.52,.58],[-.18,1.92,.22,.50],[.12,2.05,-.30,.44]]){const crack=rock(new THREE.BoxGeometry(.07,.62,.04),[px,py,.77],[sx,1,1],fel);crack.rotation.z=rz;}
 const backSpikes=[];for(const side of [-1,1]){const spike=rock(new THREE.ConeGeometry(.28,1.28,7),[side*.67,3.20,.35],[1,1,1],stone);spike.rotation.z=-side*.48;spike.rotation.x=-.26;backSpikes.push(spike);}
 const aura=new THREE.Mesh(new THREE.RingGeometry(1.28,1.58,24),felFx.clone());aura.rotation.x=-Math.PI/2;aura.position.y=.06;visual.add(aura);const innerAura=new THREE.Mesh(new THREE.RingGeometry(.72,.82,20),felFx.clone());innerAura.rotation.x=-Math.PI/2;innerAura.position.y=.07;visual.add(innerAura);visual.scale.setScalar(1.12);infernal.mesh.add(visual);infernal.infernalVisual=visual;infernal.receiveHeal=()=>{};infernal.nextTargetAt=0;infernal.chaseTarget=null;
 infernal.die=(killer)=>{if(!infernal.alive)return;infernal.alive=false;infernal.hp=0;infernal.cast=null;infernal.mesh.visible=false;if(infernal.plate)infernal.plate.style.opacity='0';if(killer){killer.stats.kb++;this.float(infernal,'INFERNAL DESTROYED','error');this.log(`${killer.name} destroyed ${owner.name}'s Infernal.`);}if(this.target===infernal)this.target=null;};
 infernal.update=dt=>{
  if(!infernal.alive)return;infernal.effects=infernal.effects.filter(e=>(e.time-=dt)>0);if(!owner.alive||this.time>=infernal.expiresAt){infernal.die(null);return;}
  const stunned=!!(infernal.has('stun')||infernal.has('furyStun')||infernal.has('cheapStun')||infernal.has('gouge')||infernal.has('blind')||infernal.has('windIncap')||infernal.has('fear'));
  if(stunned){infernal.nextPulseAt+=dt;infernal.nextManaAt+=dt;}
  if(!stunned&&(this.time>=infernal.nextTargetAt||!infernal.chaseTarget?.alive)){infernal.nextTargetAt=this.time+.20;let nearest=null,nearestSq=Infinity;for(const unit of this.units){if(unit.team===owner.team||!unit.alive||unit.healingStreamTotem||unit.summonedUnit)continue;const dx=unit.x-infernal.x,dz=unit.z-infernal.z,dSq=dx*dx+dz*dz;if(dSq<nearestSq){nearestSq=dSq;nearest=unit;}}infernal.chaseTarget=nearest;}
  const nearest=infernal.chaseTarget;let walking=false;if(!stunned&&nearest){const dx=nearest.x-infernal.x,dz=nearest.z-infernal.z,d=Math.hypot(dx,dz)||1;if(d>2.55){infernal.x+=dx/d*infernal.moveSpeed*dt;infernal.z+=dz/d*infernal.moveSpeed*dt;this.arena.constrain(infernal);walking=true;}infernal.mesh.rotation.y=Math.atan2(dx,dz);}
  if(!stunned){while(this.time>=infernal.nextManaAt){infernal.nextManaAt+=1;this.gainMana(owner,4);}while(this.time>=infernal.nextPulseAt){infernal.nextPulseAt+=2;infernal.slamTime=.62;const victims=this.units.filter(u=>u.team!==owner.team&&u.alive&&!u.healingStreamTotem&&dist(u,infernal)<=8&&this.arena.los(infernal,u));victims.forEach((u,i)=>{this.damage(owner,u,50,'Infernal Immolation');if(i<2)this.vfxBurst(u,0x65ff20,.42);});this.vfxRing(infernal,0x65ff20,2.8);this.vfxNova(infernal,0x238b12,1.9,8);this.float(infernal,`FEL IMMOLATION ×${victims.length}`,'damage');}}
  infernal.slamTime=Math.max(0,infernal.slamTime-dt);infernal.visualX=infernal.x;infernal.visualZ=infernal.z;infernal.mesh.position.set(infernal.x,0,infernal.z);const gait=Math.sin(this.time*7.4)*(walking?.34:.05),heave=Math.abs(Math.sin(this.time*7.4))*(walking?.09:.025),slam=infernal.slamTime>0?Math.sin((1-infernal.slamTime/.62)*Math.PI):0;armPivots.forEach((arm,i)=>arm.rotation.x=slam?-1.72*slam:(i?1:-1)*gait);legPivots.forEach((leg,i)=>leg.rotation.x=(i?-1:1)*gait*.72);visual.position.y=heave-slam*.12;visual.rotation.x=slam*.16;aura.rotation.z-=dt*1.5;innerAura.rotation.z+=dt*2.1;chestCore.scale.setScalar(1+Math.sin(this.time*7)*.08);
 };
 this.vfxRing(infernal,owner.team==='ally'?COLORS.ally:COLORS.enemy,2.4);this.vfxNova(infernal,0x65ff20,2.5,8);this.float(infernal,`${infernal.maxHp} HP · CHASING`,'info');this.log(`${owner.name} summoned a killable Infernal with ${infernal.maxHp} health for 10 sec; it will chase the nearest enemy.`);
};
Game.prototype.spawnHealingStreamTotem=function(owner,ability){
 if(!owner?.alive)return;this.units.filter(u=>u.healingStreamTotem&&u.alive&&u.totemOwner===owner).forEach(u=>u.die(null));
 const totem=this.spawn('Healing Stream Totem','storm',owner.team,owner.x,owner.z,false);totem.ai=null;totem.healingStreamTotem=true;totem.totemOwner=owner;totem.maxHp=280;totem.hp=280;totem.maxResource=0;totem.resource=0;totem.moveSpeed=0;totem.expiresAt=this.time+10;totem.nextPulseAt=this.time+2;totem.mesh.children.forEach(child=>child.visible=false);
 const visual=new THREE.Group();visual.visible=true;const teamColour=owner.team==='ally'?COLORS.ally:COLORS.enemy,wood=new THREE.MeshStandardMaterial({color:0x315b62,roughness:.55,metalness:.18}),glow=new THREE.MeshStandardMaterial({color:0x75efff,emissive:0x4cdfff,emissiveIntensity:1.15,roughness:.24,metalness:.22}),light=new THREE.MeshBasicMaterial({color:teamColour,transparent:true,opacity:.72,depthWrite:false,blending:THREE.AdditiveBlending});
 const base=new THREE.Mesh(new THREE.CylinderGeometry(.42,.58,.28,8),wood);base.position.y=.14;visual.add(base);const pillar=new THREE.Mesh(new THREE.CylinderGeometry(.18,.28,1.15,8),wood);pillar.position.y=.82;visual.add(pillar);const crystal=new THREE.Mesh(new THREE.OctahedronGeometry(.34),glow);crystal.position.y=1.52;visual.add(crystal);for(const y of [.48,1.12]){const band=new THREE.Mesh(new THREE.TorusGeometry(.31,.055,7,20),light.clone());band.rotation.x=Math.PI/2;band.position.y=y;visual.add(band);}const range=new THREE.Mesh(new THREE.RingGeometry(1.05,1.15,36),light.clone());range.rotation.x=-Math.PI/2;range.position.y=.035;visual.add(range);totem.mesh.add(visual);totem.totemVisual=visual;
 totem.receiveHeal=()=>{};
 totem.die=(killer)=>{if(!totem.alive)return;totem.alive=false;totem.hp=0;totem.cast=null;totem.mesh.visible=false;if(totem.plate)totem.plate.style.opacity='0';if(killer){killer.stats.kb++;this.float(totem,'TOTEM DESTROYED','error');this.log(`${killer.name} destroyed ${owner.name}'s Healing Stream Totem.`);}if(this.target===totem)this.target=null;};
 totem.update=(dt)=>{if(!totem.alive)return;if(this.time>=totem.expiresAt){totem.die(null);return;}totem.visualX=totem.x;totem.visualZ=totem.z;totem.mesh.position.set(totem.x,0,totem.z);visual.rotation.y+=dt*.75;crystal.rotation.y+=dt*2.6;range.material.opacity=.38+Math.sin(this.time*5)*.18;if(this.time>=totem.nextPulseAt){totem.nextPulseAt+=2;const allies=this.units.filter(u=>u.alive&&!u.healingStreamTotem&&u.team===owner.team&&dist(u,totem)<=18);allies.forEach((u,i)=>{this.heal(owner,u,ability.value||90,'Healing Stream Totem');this.vfxGlyph(u,0x82f4ff,.48);if(i<3)this.vfxRing(u,0x62dff5,.85);});this.vfxNova(totem,0x75efff,2.0,12);this.float(totem,`HEALING STREAM ×${allies.length}`,'heal');}};
 this.vfxRing(totem,teamColour,1.8);this.vfxGlyph(totem,0x8ff7ff,.75);this.float(totem,'280 HP · 10 SEC · 18M','info');this.log(`${owner.name} summoned a 280-health Healing Stream Totem for 10 sec with an 18m healing radius.`);
};
/* Explicit bridge for the separately-scoped multiplayer script. Keeping these
   references behind one object prevents ReferenceErrors across script scopes. */
window.AETHER_ONLINE_BRIDGE={CLASS_INFO:CLASS_INFO,AB:AB,AIController:AIController,getProgression:()=>progression,getNormalizedGearStats:(cls,ilvl=990)=>{const totals=blankStats(),preferred=GEAR_BUILD_INFO[cls]?.stats||['Power','Vitality'];GEAR_SLOTS.forEach(slot=>{const values=itemStatValues({classKey:cls,slot,ilvl,statA:preferred[0],statB:preferred[1]});GEAR_STATS.forEach(stat=>totals[stat]+=values[stat]||0);});return totals;}};
window.__aetherStart=async()=>{ if(window.__aetherStarted)return; window.__aetherStarted=true; try{ await AetherKit.loadAll(); }catch(e){ console.error('AetherKit model load failed:',e); } syncTalentUnlockedAbilities();const game=new Game(); window.game=game;try{window.CLASSES=CLASSES;window.GEAR_CLASSES=GEAR_CLASSES;}catch(e){}document.addEventListener('click',e=>{if(e.target.closest&&e.target.closest('#closeTalents')){$('#talents')?.classList.add('hidden');document.getElementById('talentTip')?.remove();return;}if(e.target.closest&&e.target.closest('#talentsBtn')){e.preventDefault();try{aetherBasicTalentTree(($('#classSelect')&&$('#classSelect').value)||'flame');}catch(err){console.error('Talent button fallback failed:',err);try{game.safeOpenTalents(($('#classSelect')&&$('#classSelect').value)||'flame');}catch(e2){console.error(e2);$('#talents')?.classList.remove('hidden');}}}}); };
if(window.__THREE_READY){ window.__aetherStart(); }
})();
