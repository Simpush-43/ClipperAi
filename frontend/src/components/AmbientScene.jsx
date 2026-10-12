import { useEffect, useRef } from "react";

export function AmbientScene({ active }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let disposed = false;
    let animationId;
    let observer;
    let renderer;
    let scene;

    import("three").then((THREE) => {
      if (disposed) return;
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
      camera.position.set(0, 0, 8);
      const group = new THREE.Group();
      const bars = [];
      for (let index = 0; index < 32; index++) {
        const height = 0.18 + Math.random() * 1.2;
        const material = new THREE.MeshBasicMaterial({ color: 0x70aa9a, transparent: true, opacity: 0.65 });
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.025, height, 0.025), material);
        bar.position.set((index - 15.5) * 0.14, Math.sin(index * 0.33) * 0.32, (Math.random() - 0.5) * 0.5);
        bar.material.opacity = 0.28 + Math.random() * 0.52;
        group.add(bar);
        bars.push(bar);
      }
      scene.add(group);
      let frame = 0;
      const resize = () => {
        const { width, height } = canvas.getBoundingClientRect();
        if (!width || !height) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(canvas);
      let lastFrameTime = 0;
      const animate = () => {
        animationId = requestAnimationFrame(animate);
        if (document.hidden) return;
        const now = performance.now();
        if (now - lastFrameTime < 1000 / 30) return;
        lastFrameTime = now;
        frame += 0.016;
        bars.forEach((bar, index) => {
          const wave = Math.sin(frame + index * 0.36) * 0.5 + 0.5;
          bar.scale.y = active ? 0.55 + wave * 0.9 : 0.75 + wave * 0.18;
          bar.material.opacity = active ? 0.35 + wave * 0.6 : 0.18 + wave * 0.28;
        });
        group.rotation.y = Math.sin(frame * 0.22) * 0.1;
        renderer.render(scene, camera);
      };
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        renderer.render(scene, camera);
      } else {
        animate();
      }
    }).catch((error) => console.error("Three.js visualization unavailable", error));

    return () => {
      disposed = true;
      cancelAnimationFrame(animationId);
      observer?.disconnect();
      scene?.traverse((object) => {
        object.geometry?.dispose();
        if (Array.isArray(object.material)) object.material.forEach((item) => item.dispose());
        else object.material?.dispose();
      });
      renderer?.dispose();
    };
  }, [active]);

  return <canvas ref={canvasRef} className="signal-canvas" aria-hidden="true" />;
}
