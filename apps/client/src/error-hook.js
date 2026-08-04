window.AETHER_GLOBAL_ERROR_HOOK_V132=true;
window.addEventListener('error',e=>console.error('Aetherfall runtime error:',e.message,e.error));
window.addEventListener('unhandledrejection',e=>console.error('Aetherfall promise error:',e.reason));
