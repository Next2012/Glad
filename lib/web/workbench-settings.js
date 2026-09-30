let workbenchSettingsTimer = null;
let workbenchCardsSnapshot = '';

function workbenchSettingsStatus(message, failed = false) {
    const target = document.getElementById('workbench-settings-status');
    target.textContent = message;
    target.classList.toggle('error', failed);
}

async function workbenchSettingsRequest(path = '', options = {}) {
    const response = await fetchWithTimeout('/api/agent-workbench' + path, {
        headers: {'Content-Type':'application/json'}, ...options
    }, 15000);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Could not update workbench settings');
    return value;
}

function renderWorkbenchSettings(value, updateIdentity = false) {
    if (updateIdentity) {
        document.getElementById('workbench-glad-id').value = value.gladId;
        document.getElementById('workbench-glad-alias').value = value.alias;
        document.getElementById('workbench-directory').value ||= value.defaultWorkingDirectory || appConfig.defaultWorkingDirectory;
        document.getElementById('workbench-config-path').textContent = `Configuration: ${value.configPath}`;
    }
    const snapshot = JSON.stringify(value.workbenches);
    if (snapshot === workbenchCardsSnapshot) return;
    workbenchCardsSnapshot = snapshot;
    const list = document.getElementById('workbench-connection-cards');
    list.replaceChildren();
    if (!value.workbenches.length) {
        const empty = document.createElement('p');
        empty.className = 'serverchan-help'; empty.textContent = 'No workbenches added.'; list.appendChild(empty);
    }
    for (const item of value.workbenches) {
        const card = document.createElement('article'); card.className = 'workbench-connection-card';
        const heading = document.createElement('div'); heading.className = 'workbench-card-heading';
        const title = document.createElement('strong'); title.textContent = item.workbenchAlias || new URL(item.url).host;
        const status = document.createElement('span'); status.className = `workbench-status ${item.state}`;
        status.textContent = {connected:'Connected',connecting:'Connecting',disconnecting:'Disconnecting',disconnected:'Disconnected'}[item.state] || item.state;
        heading.append(title,status); card.appendChild(heading);
        for (const text of [item.workbenchId ? `ID: ${item.workbenchId}` : 'Workbench identity appears after connecting.', item.url]) {
            const line = document.createElement('p'); line.className = 'workbench-card-detail'; line.textContent = text; card.appendChild(line);
        }
        const actions = document.createElement('div'); actions.className = 'workbench-card-actions';
        const label = document.createElement('label'); label.className = 'workbench-connect-toggle';
        const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = item.autoConnect;
        toggle.setAttribute('aria-label',`Auto-connect ${item.workbenchAlias || new URL(item.url).host}`);
        const caption = document.createElement('span'); caption.textContent = 'Auto-connect';
        toggle.onchange = async () => {
            toggle.disabled = true;
            try { renderWorkbenchSettings(await workbenchSettingsRequest('/targets/'+encodeURIComponent(item.id),{method:'PATCH',body:JSON.stringify({enabled:toggle.checked})})); }
            catch (error) { workbenchSettingsStatus(error.message,true); toggle.checked = item.autoConnect; }
            finally { toggle.disabled = false; }
        };
        label.append(toggle,caption);
        const remove = document.createElement('button'); remove.type='button'; remove.className='small-btn danger'; remove.textContent='Delete';
        remove.onclick = async () => {
            if (!window.confirm(`Delete ${item.workbenchAlias || new URL(item.url).host}? Its connection will close.`)) return;
            try { renderWorkbenchSettings(await workbenchSettingsRequest('/targets/'+encodeURIComponent(item.id),{method:'DELETE'})); }
            catch (error) { workbenchSettingsStatus(error.message,true); }
        };
        actions.append(label,remove); card.appendChild(actions);
        if (item.error) { const error = document.createElement('p'); error.className='workbench-card-error'; error.textContent=item.error; card.appendChild(error); }
        list.appendChild(card);
    }
}

async function loadWorkbenchSettings() {
    stopWorkbenchSettingsPolling();
    try { renderWorkbenchSettings(await workbenchSettingsRequest(),true); }
    catch (error) { workbenchSettingsStatus(error.message,true); }
    workbenchSettingsTimer = setInterval(async () => {
        try { renderWorkbenchSettings(await workbenchSettingsRequest()); }
        catch (error) { workbenchSettingsStatus(error.message,true); }
    },2000);
}

function stopWorkbenchSettingsPolling() { clearInterval(workbenchSettingsTimer); workbenchSettingsTimer=null; }

async function saveWorkbenchAlias() {
    try {
        renderWorkbenchSettings(await workbenchSettingsRequest('',{method:'PATCH',body:JSON.stringify({alias:document.getElementById('workbench-glad-alias').value})}),true);
        workbenchSettingsStatus('Glad alias saved.');
    } catch (error) { workbenchSettingsStatus(error.message,true); }
}

async function addWorkbenchTarget(event) {
    event.preventDefault();
    const button=document.getElementById('workbench-add-button'); button.disabled=true;
    try {
        const file=document.getElementById('workbench-ca').files[0];
        const body={url:document.getElementById('workbench-url').value,token:document.getElementById('workbench-token').value,
            workingDirectory:document.getElementById('workbench-directory').value,caCertificate:file ? await file.text() : '',
            mcpUrl:document.getElementById('workbench-mcp-url').value,mcpTokenFile:document.getElementById('workbench-mcp-token-file').value,autoConnect:false};
        renderWorkbenchSettings(await workbenchSettingsRequest('/targets',{method:'POST',body:JSON.stringify(body)}));
        document.getElementById('workbench-token').value='';
        document.querySelector('.workbench-add').open=false;
        workbenchSettingsStatus('Workbench added. Use its switch to connect.');
    } catch (error) { workbenchSettingsStatus(error.message,true); }
    finally { button.disabled=false; }
}

async function copyWorkbenchField(id) {
    const field=document.getElementById(id);
    try { if (navigator.clipboard) await navigator.clipboard.writeText(field.value); else { field.select(); if (!document.execCommand('copy')) throw new Error('Copy unavailable'); } workbenchSettingsStatus('Copied.'); }
    catch (_) { workbenchSettingsStatus('Select the ID and copy it manually.'); }
}
