import * as THREE from 'three';
  import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
  import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
  window.THREE=THREE; window.GLTFLoader=GLTFLoader; window.__skeletonClone=skeletonClone;
  window.__THREE_READY=true;
  if(window.__aetherStart) window.__aetherStart();
