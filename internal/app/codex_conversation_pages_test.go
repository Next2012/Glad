package app

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func codexPagingHistory(threadID string) map[string]any {
	turns := []any{}
	for index := 0; index < 20; index++ {
		turns = append(turns, map[string]any{"id": fmt.Sprintf("recovered-%d", index), "createdAt": 1700000000 + index, "completedAt": 1700000001 + index, "status": "completed", "items": []any{
			map[string]any{"id": fmt.Sprintf("user-%d", index), "type": "userMessage", "content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("Recovered prompt %d", index)}}},
			map[string]any{"id": fmt.Sprintf("answer-%d", index), "type": "agentMessage", "text": fmt.Sprintf("Recovered answer %d", index)},
		}})
	}
	return map[string]any{"thread": map[string]any{"id": threadID, "name": "Recovered B", "turns": turns}}
}

func TestCodexHydrationResumeAndForkPublishIdentityWithFirstTailCursor(t *testing.T) {
	for _, fork := range []bool{false, true} {
		t.Run(fmt.Sprintf("fork=%t", fork), func(t *testing.T) {
			session, server := conversationFixture(t, 20)
			session.Kind, session.Tool.Key = "codex-structured", "codex"
			session.State["threadId"] = "thread-a"
			provider := NewCodexProvider(session, nil)
			provider.threadID, provider.forking = "thread-b", fork
			session.Provider = provider
			subscription, previous := session.subscribeConversation(32, true)
			defer subscription.Close()
			window := newConversationEventWindow(session, true, previous)
			if err := provider.hydrateThread(context.Background(), codexPagingHistory("thread-b")); err != nil {
				t.Fatal(err)
			}
			// Consume the history reset before the outer Resume/Fork publishes
			// its final idle state: this is the formerly racy scheduling window.
			reset := window.project((<-subscription.Events()).Payload)
			if stringValue(mapValue(reset["state"])["threadId"]) != "thread-b" {
				t.Fatal("recovered messages were published with the previous native identity")
			}
			cursor := stringValue(mapValue(reset["historyPage"])["beforeCursor"])
			if cursor == "" {
				t.Fatal("fixture did not exercise an earlier page")
			}
			provider.forking = false
			provider.updatePublicState("idle")
			response := conversationRequest(server, "/api/sessions/conversation/conversation?before="+cursor)
			if response.Code != http.StatusOK {
				t.Fatalf("first recovered cursor became invalid after idle publication: %d", response.Code)
			}
		})
	}
}

func TestCodexHydrationNameFailureLeavesHistoryIdentityAndCursorUnchanged(t *testing.T) {
	for _, fork := range []bool{false, true} {
		t.Run(fmt.Sprintf("fork=%t", fork), func(t *testing.T) {
			session, server := conversationFixture(t, 20)
			session.Kind, session.Tool.Key = "codex-structured", "codex"
			session.State["threadId"] = "thread-a"
			blocked := filepath.Join(t.TempDir(), "not-a-directory")
			if err := os.WriteFile(blocked, []byte("blocked"), 0600); err != nil {
				t.Fatal(err)
			}
			session.names = &SessionNameStore{directory: blocked}
			provider := NewCodexProvider(session, nil)
			provider.threadID, provider.forking = "thread-b", fork
			session.mu.RLock()
			before := session.conversationSnapshotLocked()
			session.mu.RUnlock()
			if err := provider.hydrateThread(context.Background(), codexPagingHistory("thread-b")); err == nil {
				t.Fatal("name registration failure was ignored")
			}
			session.mu.RLock()
			after := session.conversationSnapshotLocked()
			session.mu.RUnlock()
			if stringValue(mapValue(after["state"])["threadId"]) != "thread-a" || mapValue(after["historyPage"])["epoch"] != mapValue(before["historyPage"])["epoch"] || session.Messages[1]["id"] != "turn-start-0" {
				t.Fatal("failed hydration replaced the old history or identity")
			}
			cursor := stringValue(mapValue(before["historyPage"])["beforeCursor"])
			if conversationRequest(server, "/api/sessions/conversation/conversation?before="+cursor).Code != http.StatusOK {
				t.Fatal("failed hydration invalidated the old conversation cursor")
			}
		})
	}
}

func TestCodexRecoveryFailureKeepsActualAndDisplayedConversationAligned(t *testing.T) {
	for _, fork := range []bool{false, true} {
		for _, cancellation := range []bool{false, true} {
			t.Run(fmt.Sprintf("fork=%t/cancel=%t", fork, cancellation), func(t *testing.T) {
				provider, writes, _ := historyTestProvider(t)
				session := provider.session
				t.Cleanup(session.cancel)
				provider.threadID = "thread-a"
				if err := provider.hydrateThread(context.Background(), codexPagingHistory("thread-a")); err != nil {
					t.Fatal(err)
				}
				session.mu.RLock()
				before := session.conversationSnapshotLocked()
				firstID := session.Messages[0]["id"]
				session.mu.RUnlock()
				blocked := filepath.Join(t.TempDir(), "not-a-directory")
				if err := os.WriteFile(blocked, []byte("blocked"), 0600); err != nil {
					t.Fatal(err)
				}
				session.names = &SessionNameStore{directory: blocked}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				done := make(chan error, 1)
				go func() {
					if fork {
						_, err := provider.Fork(ctx, "different-source-c")
						done <- err
					} else {
						done <- provider.Resume(ctx, "thread-b")
					}
				}()
				request := historyTestRequest(t, writes)
				if cancellation {
					cancel()
				} else {
					provider.handleRPC(map[string]any{"id": request["id"], "result": codexPagingHistory("thread-b")})
				}
				select {
				case err := <-done:
					if err == nil {
						t.Fatal("failed recovery was accepted")
					}
				case <-time.After(5 * time.Second):
					t.Fatal("failed recovery remained blocked")
				}
				provider.mu.Lock()
				actual, needsResume := provider.threadID, provider.needsThreadResume
				provider.mu.Unlock()
				session.mu.RLock()
				after := session.conversationSnapshotLocked()
				unchanged := session.Messages[0]["id"] == firstID
				session.mu.RUnlock()
				if actual != "thread-a" || !needsResume || stringValue(mapValue(after["state"])["threadId"]) != "thread-a" || !unchanged || mapValue(after["historyPage"])["epoch"] != mapValue(before["historyPage"])["epoch"] {
					t.Fatal("failed recovery left actual native conversation and displayed history inconsistent")
				}
				manager := NewSessionManager(t.TempDir())
				manager.sessions[session.ID] = session
				server := &Server{sessions: manager}
				cursor := stringValue(mapValue(before["historyPage"])["beforeCursor"])
				if conversationRequest(server, "/api/sessions/"+session.ID+"/conversation?before="+cursor).Code != http.StatusOK {
					t.Fatal("failed recovery broke the source cursor")
				}
			})
		}
	}
}

func TestCodexEmptyForkUsesOnlyCurrentSourceProjection(t *testing.T) {
	for _, currentSource := range []bool{false, true} {
		t.Run(fmt.Sprintf("current-source=%t", currentSource), func(t *testing.T) {
			provider, writes, _ := historyTestProvider(t)
			session := provider.session
			t.Cleanup(session.cancel)
			provider.threadID = "thread-a"
			if err := provider.hydrateThread(context.Background(), codexPagingHistory("thread-a")); err != nil {
				t.Fatal(err)
			}
			source := "different-source-c"
			if currentSource {
				source = "thread-a"
			}
			result := make(chan error, 1)
			go func() { _, err := provider.Fork(context.Background(), source); result <- err }()
			request := historyTestRequest(t, writes)
			if request["method"] != "thread/fork" || stringValue(mapValue(request["params"])["threadId"]) != source {
				t.Fatal("fork did not use the selected source")
			}
			provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{
				"thread": map[string]any{"id": "fork-b"}, "initialTurnsPage": map[string]any{"data": []any{}, "nextCursor": nil},
			}})
			select {
			case err := <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("empty fork did not finish")
			}
			session.mu.RLock()
			defer session.mu.RUnlock()
			if stringValue(session.State["threadId"]) != "fork-b" {
				t.Fatal("fork native identity was lost")
			}
			if currentSource && len(session.Messages) == 0 {
				t.Fatal("current-source fallback stopped preserving the displayed source")
			}
			if !currentSource && len(session.Messages) != 0 {
				t.Fatal("fork of C displayed unrelated current conversation A")
			}
		})
	}
}
