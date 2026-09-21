        function codexPlanPhase(item) {
            return agentPlanPhase(item);
        }
        function renderCodexPlan(item, floating = false, initiallyOpen = false) {
            return renderAgentPlan(item, { floating, initiallyOpen, keyPrefix: 'plan' });
        }
        function codexPlanLayout(messages, rootThreadId) {
            const rootMessages = messages.filter(item => !isCodexSubagentItem(item, rootThreadId));
            const latestTurn = rootMessages.findLast(item => item.kind === 'turn-start');
            const latestPlan = rootMessages.findLast(item => item.kind === 'task-plan'
                && (!latestTurn || item.turnId === latestTurn.turnId));
            const floatingPlan = latestPlan?.plan?.length && latestPlan.planTurnStatus === 'running' ? latestPlan : null;
            const firstUserByTurn = new Map();
            const firstReplyByTurn = new Map();
            let pendingUser = null;
            for (const item of rootMessages) {
                if (item.kind === 'user') {
                    if (item.turnId) {
                        if (!firstUserByTurn.has(item.turnId)) firstUserByTurn.set(item.turnId, item);
                    } else pendingUser = item;
                } else if (item.kind === 'turn-start') {
                    // Local input precedes turn/start and may not have received
                    // its Codex userMessage echo (and turn id) yet.
                    if (pendingUser && !firstUserByTurn.has(item.turnId)) firstUserByTurn.set(item.turnId, pendingUser);
                    pendingUser = null;
                } else if (item.kind === 'turn-end') pendingUser = null;
                else if (item.kind === 'assistant' && !firstReplyByTurn.has(item.turnId)) firstReplyByTurn.set(item.turnId, item);
            }
            const plansAfterUser = new Map();
            const plansBeforeReply = new Map();
            const placedPlans = new Set();
            for (const plan of rootMessages) {
                if (plan.kind !== 'task-plan' || !plan.plan?.length || plan.planTurnStatus === 'running') continue;
                const user = firstUserByTurn.get(plan.turnId);
                const reply = firstReplyByTurn.get(plan.turnId);
                if (user) plansAfterUser.set(user, plan);
                else if (reply) plansBeforeReply.set(reply, plan);
                else continue;
                placedPlans.add(plan);
            }
            return { floatingPlan, plansAfterUser, plansBeforeReply, placedPlans };
        }
