package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

type targetPod struct {
	Name     string
	UID      string
	Ready    bool
	Deleting bool
}

type deploymentDocument struct {
	Spec struct {
		Selector struct {
			MatchLabels      map[string]string `json:"matchLabels"`
			MatchExpressions []struct {
				Key      string   `json:"key"`
				Operator string   `json:"operator"`
				Values   []string `json:"values"`
			} `json:"matchExpressions"`
		} `json:"selector"`
	} `json:"spec"`
}

type podListDocument struct {
	Items []struct {
		Metadata struct {
			Name              string  `json:"name"`
			UID               string  `json:"uid"`
			DeletionTimestamp *string `json:"deletionTimestamp"`
		} `json:"metadata"`
		Status struct {
			Phase      string `json:"phase"`
			Conditions []struct {
				Type   string `json:"type"`
				Status string `json:"status"`
			} `json:"conditions"`
			ContainerStatuses []struct {
				Name  string `json:"name"`
				Ready bool   `json:"ready"`
			} `json:"containerStatuses"`
		} `json:"status"`
	} `json:"items"`
}

func deploymentTargetPods(ctx context.Context, cfg *config) ([]targetPod, error) {
	parts := strings.Split(cfg.Remote.Target, "/")
	if len(parts) != 4 || parts[0] != "deployment" {
		return nil, fmt.Errorf("target %q is not a deployment target", cfg.Remote.Target)
	}
	deploymentName, containerName := parts[1], parts[3]
	deploymentCommand := "kubectl -n " + shellQuote(cfg.Remote.Namespace) + " get deployment " + shellQuote(deploymentName) + " -o json"
	deploymentJSON, err := capture(ctx, "ssh", cfg.Remote.SSH, deploymentCommand)
	if err != nil {
		return nil, fmt.Errorf("read target deployment: %w: %s", err, strings.TrimSpace(deploymentJSON))
	}
	var deployment deploymentDocument
	if err := json.Unmarshal([]byte(deploymentJSON), &deployment); err != nil {
		return nil, fmt.Errorf("decode target deployment: %w", err)
	}
	selector, err := kubernetesSelector(deployment)
	if err != nil {
		return nil, err
	}
	podsCommand := "kubectl -n " + shellQuote(cfg.Remote.Namespace) + " get pods -l " + shellQuote(selector) + " -o json"
	podsJSON, err := capture(ctx, "ssh", cfg.Remote.SSH, podsCommand)
	if err != nil {
		return nil, fmt.Errorf("read target pods: %w: %s", err, strings.TrimSpace(podsJSON))
	}
	var pods podListDocument
	if err := json.Unmarshal([]byte(podsJSON), &pods); err != nil {
		return nil, fmt.Errorf("decode target pods: %w", err)
	}
	result := make([]targetPod, 0, len(pods.Items))
	for _, item := range pods.Items {
		podReady := false
		for _, condition := range item.Status.Conditions {
			if condition.Type == "Ready" && condition.Status == "True" {
				podReady = true
				break
			}
		}
		containerReady := false
		for _, status := range item.Status.ContainerStatuses {
			if status.Name == containerName {
				containerReady = status.Ready
				break
			}
		}
		result = append(result, targetPod{
			Name:     item.Metadata.Name,
			UID:      item.Metadata.UID,
			Ready:    item.Status.Phase == "Running" && podReady && containerReady,
			Deleting: item.Metadata.DeletionTimestamp != nil,
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func kubernetesSelector(deployment deploymentDocument) (string, error) {
	var terms []string
	keys := make([]string, 0, len(deployment.Spec.Selector.MatchLabels))
	for key := range deployment.Spec.Selector.MatchLabels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		terms = append(terms, key+"="+deployment.Spec.Selector.MatchLabels[key])
	}
	for _, expression := range deployment.Spec.Selector.MatchExpressions {
		values := append([]string(nil), expression.Values...)
		sort.Strings(values)
		switch expression.Operator {
		case "In":
			terms = append(terms, expression.Key+" in ("+strings.Join(values, ",")+")")
		case "NotIn":
			terms = append(terms, expression.Key+" notin ("+strings.Join(values, ",")+")")
		case "Exists":
			terms = append(terms, expression.Key)
		case "DoesNotExist":
			terms = append(terms, "!"+expression.Key)
		default:
			return "", fmt.Errorf("unsupported deployment selector operator %q", expression.Operator)
		}
	}
	if len(terms) == 0 {
		return "", fmt.Errorf("target deployment has an empty selector")
	}
	sort.Strings(terms)
	return strings.Join(terms, ","), nil
}

func singleReadyTargetPod(pods []targetPod) (*targetPod, error) {
	var ready []targetPod
	for _, pod := range pods {
		if pod.Ready && !pod.Deleting {
			ready = append(ready, pod)
		}
	}
	if len(ready) != 1 {
		return nil, fmt.Errorf("expected exactly one ready target pod, found %d", len(ready))
	}
	return &ready[0], nil
}

func currentTargetPod(ctx context.Context, cfg *config) (*targetPod, error) {
	pods, err := deploymentTargetPods(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return singleReadyTargetPod(pods)
}

func waitForRecoverableTarget(ctx context.Context, cfg *config, previous *targetPod) (*targetPod, bool, error) {
	return waitForRecoverableTargetWithInspector(ctx, cfg, previous, deploymentTargetPods, 2*time.Second)
}

func waitForRecoverableTargetWithInspector(
	ctx context.Context,
	cfg *config,
	previous *targetPod,
	inspect func(context.Context, *config) ([]targetPod, error),
	pollInterval time.Duration,
) (*targetPod, bool, error) {
	pods, err := inspect(ctx, cfg)
	if err != nil {
		return nil, false, err
	}
	if targetStillHealthy(pods, previous.UID) {
		return nil, false, nil
	}

	fmt.Printf("target pod %s is gone or unavailable; waiting for a ready replacement...\n", previous.Name)
	timer := time.NewTimer(time.Duration(cfg.Recovery.TargetWaitSeconds) * time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		if candidate, candidateErr := singleReadyTargetPod(pods); candidateErr == nil {
			return candidate, true, nil
		}
		select {
		case <-ctx.Done():
			return nil, false, ctx.Err()
		case <-timer.C:
			return nil, false, fmt.Errorf("timed out after %ds waiting for a ready replacement target", cfg.Recovery.TargetWaitSeconds)
		case <-ticker.C:
			pods, err = inspect(ctx, cfg)
			if err != nil {
				fmt.Printf("waiting for target inspection: %v\n", err)
			}
		}
	}
}

func targetStillHealthy(pods []targetPod, uid string) bool {
	for _, pod := range pods {
		if pod.UID == uid && pod.Ready && !pod.Deleting {
			return true
		}
	}
	return false
}

func concretePodTarget(cfg *config, pod *targetPod) string {
	parts := strings.Split(cfg.Remote.Target, "/")
	return "pod/" + pod.Name + "/container/" + parts[3]
}
