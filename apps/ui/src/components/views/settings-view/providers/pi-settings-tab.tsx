import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { PI_MODELS, type PiModelId } from '@automaker/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { PiIcon } from '@/components/ui/provider-icon';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getElectronAPI } from '@/lib/electron';
import { queryKeys } from '@/lib/query-keys';
import { STALE_TIMES } from '@/lib/query-client';
import { useAppStore } from '@/store/app-store';
import { ProviderToggle } from './provider-toggle';

export function PiSettingsTab() {
  const { enabledPiModels, piDefaultModel, setPiDefaultModel, togglePiModel } = useAppStore();
  const {
    data: status,
    error,
    isPending,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: queryKeys.cli.pi(),
    queryFn: async () => {
      const setup = getElectronAPI().setup;
      if (!setup?.getPiStatus) throw new Error('Pi CLI status API not available');
      const result = await setup.getPiStatus();
      if (!result.success) throw new Error(result.error || 'Failed to fetch Pi CLI status');
      return result;
    },
    staleTime: STALE_TIMES.CLI_STATUS,
  });

  return (
    <div className="space-y-6">
      <ProviderToggle provider="pi" providerLabel="Pi" />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <PiIcon className="w-5 h-5" />
              Pi CLI
            </CardTitle>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh Pi CLI status"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <CardDescription>Run the Pi coding agent with models from LiteLLM.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {isPending && <p role="status">Checking Pi CLI…</p>}
          {error && (
            <p role="alert" className="text-destructive">
              {error.message}
            </p>
          )}
          {status && (
            <>
              <p>
                {status.installed ? 'Pi CLI installed' : 'Pi CLI not installed'}
                {status.version && ` (${status.version})`}
              </p>
              {status.path && <p className="text-muted-foreground break-all">{status.path}</p>}
              {!status.installed && (
                <div className="space-y-2">
                  <p>{status.recommendation}</p>
                  <code className="block overflow-x-auto rounded bg-muted p-3">
                    {status.installCommand}
                  </code>
                </div>
              )}
              {status.litellm && (
                <div className="space-y-2">
                  <p className="break-all">LiteLLM gateway: {status.litellm.baseUrl}</p>
                  <p>API key: {status.litellm.hasApiKey ? 'Configured' : 'Not configured'}</p>
                  <p className="text-muted-foreground break-all">
                    Models configuration: {status.litellm.modelsConfigPath}
                  </p>
                </div>
              )}
              {status.loginCommand && (
                <div className="space-y-2">
                  <p className="text-muted-foreground">
                    Run from the Automaker directory to sync Pi models with LiteLLM:
                  </p>
                  <code className="block overflow-x-auto rounded bg-muted p-3">
                    {status.loginCommand}
                  </code>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Pi Models</CardTitle>
          <CardDescription>Choose which Pi models appear in model selectors.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pi-default-model">Default model</Label>
            <Select
              value={piDefaultModel}
              onValueChange={(value) => setPiDefaultModel(value as PiModelId)}
            >
              <SelectTrigger id="pi-default-model">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {PI_MODELS.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {PI_MODELS.map((model) => (
            <div
              key={model.id}
              className="flex items-center justify-between gap-4 rounded-lg border p-3"
            >
              <div>
                <Label htmlFor={`pi-model-${model.model}`}>{model.label}</Label>
                <p className="text-xs text-muted-foreground mt-1">{model.description}</p>
              </div>
              <Switch
                id={`pi-model-${model.model}`}
                checked={enabledPiModels.includes(model.id)}
                onCheckedChange={(enabled) => togglePiModel(model.id, enabled)}
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
