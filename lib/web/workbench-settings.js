let workbenchSettingsTimer = null;
let workbenchCardsSnapshot = '';

// 身份、连接和添加表单分别反馈，避免错误出现在无关的控件旁。
function workbenchSettingsStatus(message, failed = false, area = 'general') {
    const ids = {general:'workbench-settings-status',alias:'workbench-alias-status',add:'workbench-add-status'};
    const target = document.getElementById(ids[area]);
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

async function copyWorkbenchText(value, button) {
    try {
        if (navigator.clipboard) await navigator.clipboard.writeText(value);
        else {
            const field=document.createElement('textarea');field.value=value;
            field.style.position='fixed';field.style.opacity='0';document.body.appendChild(field);
            try {field.select();if (!document.execCommand('copy')) throw new Error('Copy unavailable');}
            finally {field.remove();}
        }
        const previous=button?.textContent;
        if (button) {button.textContent='Copied';setTimeout(()=>{button.textContent=previous;},1200);}
    } catch (_) {workbenchSettingsStatus('Copy unavailable. Select the text and copy manually.');}
}

function workbenchCopyButton(text,value) {
    const button=document.createElement('button');button.type='button';button.className='workbench-text-button';
    button.textContent=text;button.onclick=()=>copyWorkbenchText(value,button);return button;
}

function renderWorkbenchSettings(value, updateIdentity = false) {
    if (updateIdentity) {
        document.getElementById('workbench-glad-id').textContent = value.gladId;
        document.getElementById('workbench-glad-alias').value = value.alias;
    }
    const snapshot = JSON.stringify(value.workbenches);
    if (snapshot === workbenchCardsSnapshot) return;
    workbenchCardsSnapshot = snapshot;
    const list = document.getElementById('workbench-connection-cards');list.replaceChildren();
    if (!value.workbenches.length) {
        const empty = document.createElement('p');empty.className='serverchan-help';
        empty.textContent='No workbenches connected yet.';list.appendChild(empty);
    }
    for (const item of value.workbenches) {
        const host=new URL(item.url).host;
        const card=document.createElement('article');card.className='workbench-connection-card';
        const heading=document.createElement('div');heading.className='workbench-card-heading';
        const title=document.createElement('strong');title.textContent=item.workbenchAlias || host;
        const status=document.createElement('span');status.className=`workbench-status ${item.state}`;
        status.textContent={connected:'Connected',connecting:'Connecting',pending:'Waiting for trust',disconnecting:'Disconnecting',disconnected:'Disconnected'}[item.state] || item.state;
        heading.append(title,status);card.appendChild(heading);
        if (item.workbenchId) {
            const row=document.createElement('div');row.className='workbench-card-detail-row';
            const id=document.createElement('p');id.className='workbench-card-detail';id.textContent=`ID: ${item.workbenchId}`;
            row.append(id,workbenchCopyButton('Copy ID',item.workbenchId));card.appendChild(row);
        }
        const addressRow=document.createElement('div');addressRow.className='workbench-card-detail-row';
        const address=document.createElement('p');address.className='workbench-card-detail';address.textContent=host;
        addressRow.append(address,workbenchCopyButton('Copy address',item.url));card.appendChild(addressRow);
        const actions=document.createElement('div');actions.className='workbench-card-actions';
        const label=document.createElement('label');label.className='workbench-connect-toggle';
        const toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=item.autoConnect;
        toggle.setAttribute('aria-label',`Auto-connect ${item.workbenchAlias || host}`);
        const caption=document.createElement('span');caption.textContent='Auto-connect';
        const errorLine=document.createElement('p');errorLine.className='workbench-feedback error';errorLine.textContent=item.error || '';
        const setEnabled=async () => {
            toggle.disabled=true;errorLine.textContent='';
            try {renderWorkbenchSettings(await workbenchSettingsRequest('/targets/'+encodeURIComponent(item.id),{method:'PATCH',body:JSON.stringify({enabled:toggle.checked})}));}
            catch (error) {errorLine.textContent=error.message;toggle.checked=item.autoConnect;}
            finally {toggle.disabled=false;}
        };
        toggle.onchange=setEnabled;label.append(toggle,caption);actions.appendChild(label);
        const buttons=document.createElement('div');
        if (item.autoConnect && item.state==='disconnected') {
            const retry=document.createElement('button');retry.type='button';retry.className='small-btn';retry.textContent='Retry';
            retry.onclick=async()=>{retry.disabled=true;toggle.checked=true;await setEnabled();retry.disabled=false;};buttons.appendChild(retry);
        }
        const remove=document.createElement('button');remove.type='button';remove.className='workbench-text-button workbench-delete';remove.textContent='Delete';
        remove.onclick=async()=>{
            if (!window.confirm(`Delete ${item.workbenchAlias || host}?`)) return;
            remove.disabled=true;
            try {renderWorkbenchSettings(await workbenchSettingsRequest('/targets/'+encodeURIComponent(item.id),{method:'DELETE'}));}
            catch (error) {errorLine.textContent=error.message;remove.disabled=false;}
        };
        buttons.appendChild(remove);actions.appendChild(buttons);card.appendChild(actions);
        if (item.state==='pending') {
            const hint=document.createElement('p');hint.className='workbench-card-detail';
            hint.textContent='Confirm trust in the workbench’s AI助理连接 page.';card.appendChild(hint);
        }
        const resourceSettings=document.createElement('details');
        const summary=document.createElement('summary');summary.textContent='MCP resource access';
        resourceSettings.appendChild(summary);
        const resourceHelp=document.createElement('p');resourceHelp.className='workbench-card-detail';
        resourceHelp.textContent='Use the same MCP identity as this assistant. Turn this connection off before saving, then turn it on again.';
        resourceSettings.appendChild(resourceHelp);
        const resourceURL=document.createElement('input');resourceURL.value=item.mcpUrl || '';
        resourceURL.placeholder='MCP HTTP URL';resourceURL.setAttribute('aria-label',`MCP URL ${host}`);
        const resourceToken=document.createElement('input');resourceToken.value=item.mcpTokenFile || '';
        resourceToken.placeholder='Local token file';resourceToken.setAttribute('aria-label',`MCP token file ${host}`);
        const saveResources=document.createElement('button');saveResources.type='button';saveResources.className='small-btn';
        saveResources.textContent='Save resource access';saveResources.disabled=item.state!=='disconnected';
        saveResources.onclick=async()=>{
            saveResources.disabled=true;
            try {renderWorkbenchSettings(await workbenchSettingsRequest('/targets/'+encodeURIComponent(item.id),{
                method:'PATCH',body:JSON.stringify({mcpUrl:resourceURL.value,mcpTokenFile:resourceToken.value})}));}
            catch(error) {errorLine.textContent=error.message;saveResources.disabled=false;}
        };
        resourceSettings.append(resourceURL,resourceToken,saveResources);card.appendChild(resourceSettings);
        card.appendChild(errorLine);list.appendChild(card);
    }
}

async function loadWorkbenchSettings() {
    stopWorkbenchSettingsPolling();
    try {renderWorkbenchSettings(await workbenchSettingsRequest(),true);workbenchSettingsStatus('');}
    catch (error) {workbenchSettingsStatus(error.message,true);}
    workbenchSettingsTimer=setInterval(async()=>{
        try {renderWorkbenchSettings(await workbenchSettingsRequest());}
        catch (error) {workbenchSettingsStatus(error.message,true);}
    },2000);
}
function stopWorkbenchSettingsPolling() {clearInterval(workbenchSettingsTimer);workbenchSettingsTimer=null;}
async function saveWorkbenchAlias() {
    try {
        renderWorkbenchSettings(await workbenchSettingsRequest('',{method:'PATCH',body:JSON.stringify({alias:document.getElementById('workbench-glad-alias').value})}),true);
        workbenchSettingsStatus('Alias saved.',false,'alias');
    } catch (error) {workbenchSettingsStatus(error.message,true,'alias');}
}
async function addWorkbenchTarget(event) {
    event.preventDefault();const button=document.getElementById('workbench-add-button');button.disabled=true;
    const address=document.getElementById('workbench-url'),token=document.getElementById('workbench-token');
    address.removeAttribute('aria-invalid');token.removeAttribute('aria-invalid');
    workbenchSettingsStatus('',false,'add');
    try {
        if (/^\w+:\/\//.test(token.value.trim())) {token.setAttribute('aria-invalid','true');token.focus();throw new Error('Copy the connection token from the workbench.');}
        const body={url:address.value,token:token.value,mcpUrl:document.getElementById('workbench-mcp-url').value,
            mcpTokenFile:document.getElementById('workbench-mcp-token-file').value,autoConnect:false};
        renderWorkbenchSettings(await workbenchSettingsRequest('/targets',{method:'POST',body:JSON.stringify(body)}));
        token.value='';address.value='';
        workbenchSettingsStatus('Added. Turn on its connection switch to pair.',false,'add');
    } catch (error) {workbenchSettingsStatus(error.message,true,'add');}
    finally {button.disabled=false;}
}
async function copyWorkbenchField(id) {
    const field=document.getElementById(id);
    await copyWorkbenchText(field.value || field.textContent,field.parentElement.querySelector('button'));
}
