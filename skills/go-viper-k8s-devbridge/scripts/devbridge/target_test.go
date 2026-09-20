package main

import (
	"context"
	"testing"
	"time"
)

func TestKubernetesSelector(t *testing.T) {
	var deployment deploymentDocument
	deployment.Spec.Selector.MatchLabels = map[string]string{"z": "last", "app": "cvat"}
	deployment.Spec.Selector.MatchExpressions = append(deployment.Spec.Selector.MatchExpressions, struct {
		Key      string   `json:"key"`
		Operator string   `json:"operator"`
		Values   []string `json:"values"`
	}{Key: "track", Operator: "In", Values: []string{"canary", "stable"}})
	got, err := kubernetesSelector(deployment)
	if err != nil {
		t.Fatal(err)
	}
	if got != "app=cvat,track in (canary,stable),z=last" {
		t.Fatalf("selector = %q", got)
	}
}

func TestSingleReadyTargetPod(t *testing.T) {
	pod, err := singleReadyTargetPod([]targetPod{
		{Name: "old", UID: "old-uid", Ready: true, Deleting: true},
		{Name: "new", UID: "new-uid", Ready: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if pod.UID != "new-uid" {
		t.Fatalf("selected pod = %+v", pod)
	}
	if _, err := singleReadyTargetPod([]targetPod{{Name: "a", Ready: true}, {Name: "b", Ready: true}}); err == nil {
		t.Fatal("expected multiple ready pods to be rejected")
	}
}

func TestTargetStillHealthy(t *testing.T) {
	pods := []targetPod{
		{Name: "healthy", UID: "healthy-uid", Ready: true},
		{Name: "terminating", UID: "terminating-uid", Ready: true, Deleting: true},
		{Name: "unready", UID: "unready-uid", Ready: false},
	}
	if !targetStillHealthy(pods, "healthy-uid") {
		t.Fatal("healthy target was not recognized")
	}
	for _, uid := range []string{"terminating-uid", "unready-uid", "missing-uid"} {
		if targetStillHealthy(pods, uid) {
			t.Fatalf("target %s should be recoverable", uid)
		}
	}
}

func TestConcretePodTarget(t *testing.T) {
	cfg := &config{}
	cfg.Remote.Target = "deployment/cvat/container/backend"
	got := concretePodTarget(cfg, &targetPod{Name: "cvat-abc"})
	if got != "pod/cvat-abc/container/backend" {
		t.Fatalf("target = %q", got)
	}
}

func TestWaitForRecoverableTargetSelectsReplacement(t *testing.T) {
	cfg := &config{}
	cfg.Recovery.TargetWaitSeconds = 30
	previous := &targetPod{Name: "old", UID: "old-uid", Ready: true}
	responses := [][]targetPod{
		{{Name: "old", UID: "old-uid", Ready: false, Deleting: true}},
		{{Name: "new", UID: "new-uid", Ready: true}},
	}
	call := 0
	inspect := func(context.Context, *config) ([]targetPod, error) {
		index := call
		if index >= len(responses) {
			index = len(responses) - 1
		}
		call++
		return responses[index], nil
	}
	got, recoverable, err := waitForRecoverableTargetWithInspector(
		context.Background(), cfg, previous, inspect, time.Millisecond,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !recoverable || got.UID != "new-uid" || call < 2 {
		t.Fatalf("unexpected recovery result: pod=%+v recoverable=%v calls=%d", got, recoverable, call)
	}
}

func TestWaitForRecoverableTargetRefusesHealthyDuplicate(t *testing.T) {
	cfg := &config{}
	cfg.Recovery.TargetWaitSeconds = 30
	previous := &targetPod{Name: "same", UID: "same-uid", Ready: true}
	inspect := func(context.Context, *config) ([]targetPod, error) {
		return []targetPod{{Name: "same", UID: "same-uid", Ready: true}}, nil
	}
	got, recoverable, err := waitForRecoverableTargetWithInspector(
		context.Background(), cfg, previous, inspect, time.Millisecond,
	)
	if err != nil {
		t.Fatal(err)
	}
	if recoverable || got != nil {
		t.Fatalf("healthy target should not be restarted: pod=%+v recoverable=%v", got, recoverable)
	}
}
