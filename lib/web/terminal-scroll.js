        const scrollChargeDurationMs = 6000;
        let isScrolling = false, scrollDir = 0, scrollSpeed = 0, rafId = null;
        let chargeBtn = null, chargeStartTime = 0, chargeRafId = null, chargePointerId = null, chargeCompleted = false;

        function getTerminalViewport() {
            return document.querySelector('.xterm-viewport');
        }

        function smoothScrollLoop() {
            if (!isScrolling) return;
            const viewport = getTerminalViewport();
            if (viewport) { viewport.scrollTop += (scrollDir * scrollSpeed); scrollSpeed = Math.min(30, scrollSpeed + 0.2); }
            rafId = requestAnimationFrame(smoothScrollLoop);
        }
        function startScroll(dir) { if (isScrolling) return; isScrolling = true; scrollDir = dir; scrollSpeed = 4; smoothScrollLoop(); }
        function stopScroll() { isScrolling = false; if (rafId) cancelAnimationFrame(rafId); }

        function jumpTerminalScroll(dir) {
            const viewport = getTerminalViewport();
            if (!viewport) return;
            viewport.scrollTop = dir < 0 ? 0 : viewport.scrollHeight;
            if (term) {
                if (dir < 0) term.scrollToTop();
                else term.scrollToBottom();
            }
        }

        function resetChargeButton(btn) {
            if (!btn) return;
            btn.classList.remove('charging');
            btn.style.setProperty('--charge', '0deg');
        }

        function stopScrollCharge() {
            stopScroll();
            if (chargeRafId) cancelAnimationFrame(chargeRafId);
            if (chargeBtn && chargePointerId !== null) {
                try { chargeBtn.releasePointerCapture(chargePointerId); } catch (_) {}
            }
            resetChargeButton(chargeBtn);
            chargeBtn = null;
            chargeStartTime = 0;
            chargeRafId = null;
            chargePointerId = null;
            chargeCompleted = false;
        }

        function updateScrollCharge() {
            if (!chargeBtn) return;
            const elapsed = performance.now() - chargeStartTime;
            const progress = Math.min(1, elapsed / scrollChargeDurationMs);
            chargeBtn.style.setProperty('--charge', (progress * 360) + 'deg');
            if (progress >= 1) {
                chargeCompleted = true;
                jumpTerminalScroll(scrollDir);
                stopScrollCharge();
                return;
            }
            chargeRafId = requestAnimationFrame(updateScrollCharge);
        }

        function startScrollCharge(e, dir) {
            e.preventDefault();
            stopScrollCharge();
            chargeBtn = e.currentTarget;
            chargePointerId = e.pointerId;
            chargeStartTime = performance.now();
            chargeCompleted = false;
            chargeBtn.classList.add('charging');
            chargeBtn.setPointerCapture(chargePointerId);
            startScroll(dir);
            updateScrollCharge();
        }

        document.getElementById('scroll-up').addEventListener('pointerdown', (e) => startScrollCharge(e, -1));
        document.getElementById('scroll-down').addEventListener('pointerdown', (e) => startScrollCharge(e, 1));
        window.addEventListener('pointerup', stopScrollCharge);
        window.addEventListener('pointercancel', stopScrollCharge);
        window.addEventListener('resize', syncLayout);

        // Git Logic
