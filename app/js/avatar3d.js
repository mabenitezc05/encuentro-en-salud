/* Avatar 3D interactivo (Three.js r147 UMD).
 * - Arrastrar para rotar, clic para saludar 👋, balanceo y rotación suave.
 * - snapshot() genera un PNG (data URL) usado como marcador en el mapa.
 * Si WebGL/Three no están disponibles, la app usa el avatar 2D (SVG).
 */
'use strict';

const Avatar3D = (function () {
  let renderer = null, scene, camera, group, rightArm, hairMeshes = [], glassesGroup;
  let headMat, shirtMat, hairMat, eyes = [];
  let mounted = false, dragging = false, moved = false;
  let lastX = 0, lastY = 0, rotY = 0, rotX = 0, autoRot = true;
  let waveT = -1, clock0 = performance.now();
  let nextBlink = performance.now() + 2500, blinkT = -1;

  const SIZE = 260;

  function available() {
    return typeof window.THREE !== 'undefined';
  }

  function mount(container) {
    if (!available() || mounted) return mounted;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    } catch (e) { return false; }
    renderer.setSize(SIZE, SIZE);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    camera.position.set(0, 0.35, 6.4);
    camera.lookAt(0, 0.1, 0);

    // luz más natural: hemisférica (cielo/suelo) + principal + contraluz
    scene.add(new THREE.HemisphereLight(0xeaf3ff, 0x8898a8, 0.65));
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(2.5, 4, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbcd8ff, 0.4);
    rim.position.set(-3, 1, -3);
    scene.add(rim);

    // sombra suave en el piso (da peso al personaje)
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.45, 32),
      new THREE.MeshBasicMaterial({ color: 0x0b2d4d, transparent: true, opacity: 0.15 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -2.0;
    scene.add(shadow);

    group = new THREE.Group();
    scene.add(group);

    // --- interacción: arrastrar = rotar, clic = saludar ---
    const el = renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false; autoRot = false;
      lastX = e.clientX; lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      rotY += dx * 0.012;
      rotX = Math.max(-0.5, Math.min(0.5, rotX + dy * 0.008));
      lastX = e.clientX; lastY = e.clientY;
    });
    el.addEventListener('pointerup', () => {
      dragging = false;
      if (!moved) wave();               // clic simple = saludo
      setTimeout(() => { autoRot = true; }, 2500);
    });

    mounted = true;
    animate();
    return true;
  }

  function clearGroup() {
    while (group.children.length) {
      const c = group.children[0];
      group.remove(c);
      c.traverse && c.traverse((m) => {
        if (m.geometry) m.geometry.dispose();
        if (m.material) m.material.dispose();
      });
    }
    hairMeshes = []; rightArm = null; glassesGroup = null;
  }

  function mat(color) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.05 });
  }

  function build(cfg) {
    clearGroup();
    headMat = mat(cfg.skin);
    shirtMat = mat(cfg.shirt);
    hairMat = mat(cfg.hair);
    const dark = mat('#22303c');

    // cuerpo
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 1.05, 1.7, 24), shirtMat);
    body.position.y = -0.95;
    group.add(body);

    // brazo izquierdo (fijo)
    const armGeo = new THREE.CylinderGeometry(0.2, 0.2, 1.05, 12);
    const armL = new THREE.Mesh(armGeo, shirtMat);
    armL.position.set(-1.0, -0.85, 0);
    armL.rotation.z = 0.28;
    group.add(armL);
    const handL = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 12), headMat);
    handL.position.set(-1.16, -1.38, 0);
    group.add(handL);

    // brazo derecho con pivote en el hombro (para saludar)
    rightArm = new THREE.Group();
    rightArm.position.set(0.95, -0.42, 0);
    const armR = new THREE.Mesh(armGeo, shirtMat);
    armR.position.set(0.12, -0.5, 0);
    armR.rotation.z = -0.28;
    rightArm.add(armR);
    const handR = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 12), headMat);
    handR.position.set(0.28, -1.0, 0);
    rightArm.add(handR);
    group.add(rightArm);

    // cabeza
    const head = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 22), headMat);
    head.position.y = 0.85;
    group.add(head);

    // orejas
    [-1, 1].forEach((s) => {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), headMat);
      ear.position.set(s * 0.98, 0.85, 0);
      group.add(ear);
    });

    // ojos (con referencia para el parpadeo)
    eyes = [];
    [-1, 1].forEach((s) => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), dark);
      eye.position.set(s * 0.34, 0.95, 0.88);
      group.add(eye);
      eyes.push(eye);
    });

    // sonrisa (arco de toro)
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.045, 8, 24, Math.PI * 0.7), dark);
    smile.position.set(0, 0.62, 0.86);
    smile.rotation.z = Math.PI * 1.15;
    group.add(smile);

    // cabello
    if (cfg.style === 'corto' || cfg.style === 'largo') {
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(1.06, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.52), hairMat);
      cap.position.y = 0.85;
      group.add(cap);
      hairMeshes.push(cap);
    }
    if (cfg.style === 'largo') {
      const back = new THREE.Mesh(
        new THREE.CylinderGeometry(1.04, 1.04, 1.5, 24, 1, true, Math.PI / 2, Math.PI),
        new THREE.MeshStandardMaterial({ color: cfg.hair, roughness: 0.65, side: THREE.DoubleSide }));
      back.position.set(0, 0.25, 0);
      group.add(back);
      hairMeshes.push(back);
    }

    // gafas
    if (cfg.glasses === 'si') {
      glassesGroup = new THREE.Group();
      [-1, 1].forEach((s) => {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.035, 8, 24), dark);
        ring.position.set(s * 0.34, 0.95, 0.93);
        glassesGroup.add(ring);
      });
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.05), dark);
      bridge.position.set(0, 0.95, 0.95);
      glassesGroup.add(bridge);
      group.add(glassesGroup);
    }
  }

  function wave() { waveT = performance.now(); }

  function animate() {
    requestAnimationFrame(animate);
    if (!renderer) return;
    const t = (performance.now() - clock0) / 1000;
    if (autoRot && !dragging) rotY += 0.006;
    group.rotation.y = rotY;
    group.rotation.x = rotX;
    group.position.y = Math.sin(t * 2.1) * 0.05;      // balanceo sutil

    // parpadeo cada 2.5–4.5 s
    const now = performance.now();
    if (blinkT < 0 && now >= nextBlink) blinkT = now;
    if (blinkT > 0) {
      const b = (now - blinkT) / 140;                       // cierre+apertura en 140 ms
      const sy = b >= 1 ? 1 : Math.max(0.12, Math.abs(1 - 2 * b));
      eyes.forEach((e) => { e.scale.y = sy; });
      if (b >= 1) { blinkT = -1; nextBlink = now + 2500 + Math.random() * 2000; }
    }

    if (rightArm) {
      if (waveT > 0) {
        const w = (performance.now() - waveT) / 1000;  // saludo de ~1.4 s
        if (w < 1.4) {
          const ramp = Math.min(1, w * 4) * Math.min(1, (1.4 - w) * 3);
          rightArm.rotation.z = (2.4 + Math.sin(w * 14) * 0.35) * ramp;
        } else { waveT = -1; rightArm.rotation.z = 0; }
      } else {
        rightArm.rotation.z = Math.sin(t * 2.1 + 1) * 0.04;
      }
    }
    renderer.render(scene, camera);
  }

  function update(cfg) {
    if (!mounted) return;
    build(cfg);
  }

  /** PNG de frente para usar como marcador / miniatura */
  function snapshot() {
    if (!mounted) return null;
    const py = group.position.y, ry = group.rotation.y, rx = group.rotation.x;
    const az = rightArm ? rightArm.rotation.z : 0;
    group.rotation.set(0, 0, 0);
    group.position.y = 0;
    if (rightArm) rightArm.rotation.z = 0;
    eyes.forEach((e) => { e.scale.y = 1; });   // sin medio-parpadeo en la foto
    renderer.render(scene, camera);
    let url = null;
    try {
      // reducir a 160px para que el marcador/BD sean livianos
      const c = document.createElement('canvas');
      c.width = c.height = 160;
      c.getContext('2d').drawImage(renderer.domElement, 0, 0, 160, 160);
      url = c.toDataURL('image/png');
    } catch (e) {}
    group.rotation.set(rx, ry, 0);
    group.position.y = py;
    if (rightArm) rightArm.rotation.z = az;
    return url;
  }

  return { available, mount, update, snapshot, wave };
})();
