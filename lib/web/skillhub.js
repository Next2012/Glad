        let skillHubSettings = null;
        let skillHallSkills = [];
        let skillHallQuery = '';

        function applySkillHubAvailability(available) {
            const button = document.getElementById('skill-hall-button');
            if (!button) return;
            button.disabled = !available;
            button.title = available ? 'Skill Hall' : 'Skill暂不可用';
            button.setAttribute('aria-label', button.title);
        }

        async function refreshSkillHubAvailability() {
            try {
                const response = await fetchWithTimeout('/api/skillhub/status', {}, 5000);
                const data = await response.json();
                applySkillHubAvailability(Boolean(response.ok && data.available));
            } catch (_) {
                applySkillHubAvailability(false);
            }
        }

        function setSkillHubStatus(message, type = '') {
            const target = document.getElementById('skillhub-settings-status');
            if (!target) return;
            target.textContent = message;
            target.className = `serverchan-settings-status${type ? ` ${type}` : ''}`;
        }

        function setSkillHubBusy(busy) {
            for (const id of ['skillhub-save-btn', 'skillhub-test-btn', 'skillhub-remove-btn']) {
                const button = document.getElementById(id);
                if (button) button.disabled = busy;
            }
        }

        function currentSkillHubForm() {
            return {
                baseUrl: document.getElementById('skillhub-base-url').value.trim(),
                token: document.getElementById('skillhub-token').value.trim()
            };
        }

        async function loadSkillHubSettings() {
            setSkillHubStatus('Loading configuration…');
            try {
                const response = await fetchWithTimeout('/api/skillhub/settings', {}, 10000);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Could not load SkillHub configuration');
                skillHubSettings = data;
                document.getElementById('skillhub-base-url').value = data.baseUrl || '';
                const token = document.getElementById('skillhub-token');
                token.value = '';
                token.placeholder = data.configured ? data.maskedToken : 'clh_...';
                document.getElementById('skillhub-token-hint').textContent = data.configured
                    ? `Saved: ${data.maskedToken}. Leave blank to keep the current Token.`
                    : 'The Token is encrypted on this Glad host.';
                document.getElementById('skillhub-remove-btn').style.display = data.configured ? 'inline-flex' : 'none';
                setSkillHubStatus(data.configured ? 'Configuration saved.' : 'SkillHub is not configured.');
            } catch (error) {
                setSkillHubStatus(error.message || 'Could not load SkillHub configuration', 'error');
            }
        }

        async function saveSkillHubSettings() {
            setSkillHubBusy(true);
            setSkillHubStatus('Testing and saving…');
            try {
                const response = await fetchWithTimeout('/api/skillhub/settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(currentSkillHubForm())
                }, 20000);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Could not save SkillHub configuration');
                skillHubSettings = data.settings;
                const token = document.getElementById('skillhub-token');
                token.value = '';
                token.placeholder = data.settings.maskedToken;
                document.getElementById('skillhub-token-hint').textContent =
                    `Saved: ${data.settings.maskedToken}. Leave blank to keep the current Token.`;
                document.getElementById('skillhub-remove-btn').style.display = 'inline-flex';
                const handle = data.user?.handle || data.user?.data?.handle || '';
                setSkillHubStatus(`Connected${handle ? ` as ${handle}` : ''}.`, 'success');
            } catch (error) {
                setSkillHubStatus(error.message || 'Could not save SkillHub configuration', 'error');
            } finally {
                setSkillHubBusy(false);
            }
        }

        async function testSkillHubSettings() {
            setSkillHubBusy(true);
            setSkillHubStatus('Testing connection…');
            try {
                const response = await fetchWithTimeout('/api/skillhub/settings/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(currentSkillHubForm())
                }, 20000);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'SkillHub connection failed');
                const handle = data.user?.handle || data.user?.data?.handle || '';
                setSkillHubStatus(`Connection successful${handle ? ` · ${handle}` : ''}.`, 'success');
            } catch (error) {
                setSkillHubStatus(error.message || 'SkillHub connection failed', 'error');
            } finally {
                setSkillHubBusy(false);
            }
        }

        async function removeSkillHubSettings() {
            if (!confirm('Remove the SkillHub connection?')) return;
            setSkillHubBusy(true);
            try {
                const response = await fetchWithTimeout('/api/skillhub/settings', { method: 'DELETE' }, 10000);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Could not remove SkillHub configuration');
                skillHubSettings = data.settings;
                document.getElementById('skillhub-base-url').value = '';
                document.getElementById('skillhub-token').value = '';
                document.getElementById('skillhub-token').placeholder = 'clh_...';
                document.getElementById('skillhub-token-hint').textContent = 'The Token is encrypted on this Glad host.';
                document.getElementById('skillhub-remove-btn').style.display = 'none';
                setSkillHubStatus('SkillHub configuration removed.', 'success');
            } catch (error) {
                setSkillHubStatus(error.message || 'Could not remove SkillHub configuration', 'error');
            } finally {
                setSkillHubBusy(false);
            }
        }

        function skillHallCard(skill, index) {
            const name = String(skill.displayName || skill.name || skill.slug || 'Unnamed Skill');
            const description = String(skill.description || '');
            const meta = [skill.kind, skill.version].filter(Boolean).join(' · ');
            return `<button type="button" class="skill-hall-card" onclick="selectSkillHallSkill(${index})"><span class="skill-hall-card-name">${escapeHtml(name)}</span>${description ? `<span class="skill-hall-card-description">${escapeHtml(description)}</span>` : ''}<span class="skill-hall-card-meta">${escapeHtml(meta)}</span></button>`;
        }

        function renderSkillHall() {
            const grid = document.getElementById('skill-hall-grid');
            const status = document.getElementById('skill-hall-status');
            if (!grid || !status) return;
            const query = skillHallQuery.trim().toLocaleLowerCase();
            const matches = skillHallSkills.map((skill, index) => ({ skill, index })).filter(({ skill }) => {
                if (!query) return true;
                return [skill.displayName, skill.name, skill.slug, skill.description, skill.kind, skill.version]
                    .some(value => String(value || '').toLocaleLowerCase().includes(query));
            });
            status.textContent = matches.length ? `${matches.length} Skill${matches.length === 1 ? '' : 's'}`
                : (query ? 'No matching Skills.' : 'No Skills are available for this account.');
            grid.innerHTML = matches.map(({ skill, index }) => skillHallCard(skill, index)).join('');
        }

        async function openSkillHall(event = null) {
            event?.stopPropagation();
            if (document.getElementById('skill-hall-button')?.disabled) {
                showAppToast('Skill暂不可用');
                return;
            }
            document.getElementById('skill-hall-overlay').style.display = 'flex';
            document.getElementById('skill-hall-search').value = '';
            document.getElementById('skill-hall-status').textContent = 'Loading Skills…';
            document.getElementById('skill-hall-grid').innerHTML = '';
            skillHallQuery = '';
            try {
                const response = await fetchWithTimeout('/api/skillhub/skills', {}, 30000);
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.error || 'Could not load Skills');
                skillHallSkills = Array.isArray(data.skills) ? data.skills : [];
                renderSkillHall();
                requestAnimationFrame(() => document.getElementById('skill-hall-search')?.focus());
            } catch (error) {
                skillHallSkills = [];
                document.getElementById('skill-hall-status').textContent = error.message || 'Could not load Skills';
                if (error.message === 'Skill暂不可用') applySkillHubAvailability(false);
            }
        }

        function closeSkillHall(event = null) {
            if (event && event.target.id !== 'skill-hall-overlay') return;
            document.getElementById('skill-hall-overlay').style.display = 'none';
        }

        function filterSkillHall(value) {
            skillHallQuery = String(value || '');
            renderSkillHall();
        }

        function selectSkillHallSkill(index) {
            const skill = skillHallSkills[index];
            if (!skill) return;
            closeSkillHall();
            showToolModal(skill);
        }

        void refreshSkillHubAvailability();
