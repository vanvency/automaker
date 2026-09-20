import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Bot, Search } from 'lucide-react';
import { getElectronAPI, isElectron, type ConversationSearchMatch } from '@/lib/electron';
import { withPageAuthParams } from '@/lib/api-fetch';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

/** Matches below this length would return most of the project */
const MIN_QUERY_CHARS = 2;
const DEBOUNCE_MS = 300;

interface ConversationSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Project whose transcripts are searched */
  projectPath?: string;
}

/**
 * Keyword search across every task conversation of the project.
 *
 * Pi writes one JSONL transcript per run, so this finds cards whose herdr tab or
 * worktree is long gone. Results link back into the card's conversation.
 */
export function ConversationSearchDialog({
  open,
  onOpenChange,
  projectPath,
}: ConversationSearchDialogProps) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<ConversationSearchMatch[]>([]);
  const [status, setStatus] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [scannedSessions, setScannedSessions] = useState(0);
  const [truncated, setTruncated] = useState(false);
  // Only the newest request may write results, so fast typing cannot race.
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open) {
      requestRef.current += 1;
      setQuery('');
      setMatches([]);
      setStatus('idle');
      return;
    }

    const needle = query.trim();
    if (needle.length < MIN_QUERY_CHARS || !projectPath) {
      requestRef.current += 1;
      setMatches([]);
      setStatus('idle');
      return;
    }

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setStatus('searching');
    const timer = setTimeout(async () => {
      try {
        const search = getElectronAPI().features?.searchConversations;
        if (!search) throw new Error('Conversation search is not supported by this client');
        const result = await search(projectPath, needle);
        if (requestRef.current !== requestId) return;
        if (!result?.success || !result.data) throw new Error(result?.error || 'Search failed');
        setMatches(result.data.matches);
        setScannedSessions(result.data.scannedSessions);
        setTruncated(result.data.truncated);
        setStatus('done');
      } catch (searchError) {
        if (requestRef.current !== requestId) return;
        setError(searchError instanceof Error ? searchError.message : String(searchError));
        setStatus('error');
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [open, query, projectPath]);

  const openConversation = useCallback(
    async (featureId: string) => {
      if (!projectPath) return;
      // Pre-open the tab so the browser keeps the user gesture while the server
      // starts or reuses the herdr attach PTY.
      const pendingTab = isElectron() ? null : window.open('', '_blank');
      try {
        const getHerdrWeb = getElectronAPI().features?.getHerdrWeb;
        if (!getHerdrWeb) throw new Error('Herdr is not supported by this client');
        const result = await getHerdrWeb(projectPath, featureId);
        if (!result?.success || !result.url) {
          throw new Error(result?.error || 'Could not open the herdr terminal');
        }
        const url = withPageAuthParams(new URL(result.url, window.location.origin));
        if (pendingTab) {
          pendingTab.location.replace(url.toString());
        } else {
          window.open(url.toString(), '_blank', 'noopener,noreferrer');
        }
      } catch (openError) {
        pendingTab?.close();
        toast.error(openError instanceof Error ? openError.message : 'Open conversation failed');
      }
    },
    [projectPath]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="conversation-search-dialog">
        <DialogHeader>
          <DialogTitle>Search conversations</DialogTitle>
          <DialogDescription>
            Keyword search across every task transcript, including runs from worktrees this project
            no longer has.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Error, file path, JIRA key…"
            className="pl-9"
            data-testid="conversation-search-input"
          />
        </div>

        <div className="min-h-[200px] max-h-[50vh] overflow-y-auto space-y-2">
          {status === 'idle' && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {projectPath
                ? `Type at least ${MIN_QUERY_CHARS} characters to search.`
                : 'Select a project first.'}
            </p>
          )}
          {status === 'searching' && (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner size="sm" />
              Searching transcripts…
            </div>
          )}
          {status === 'error' && <p className="text-sm text-destructive py-6">{error}</p>}
          {status === 'done' && matches.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No conversation mentions “{query.trim()}”.
            </p>
          )}
          {status === 'done' &&
            matches.map((match) => (
              <div
                key={match.filePath}
                className="rounded-md border border-border/60 p-3 space-y-1.5"
                data-testid="conversation-search-result"
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span
                    className={cn('font-medium truncate', match.featureId && 'text-foreground')}
                  >
                    {match.featureId ?? 'app-internal session'}
                  </span>
                  <span>{match.role}</span>
                  {match.at && <span>{new Date(match.at).toLocaleString()}</span>}
                  <span>{match.hitCount >= 50 ? '50+ hits' : `${match.hitCount} hits`}</span>
                  {match.featureId && (
                    <button
                      onClick={() => openConversation(match.featureId!)}
                      className="ml-auto flex items-center gap-1 rounded-sm px-1.5 py-0.5 hover:bg-accent hover:text-foreground transition-colors"
                      data-testid={`conversation-search-open-${match.featureId}`}
                    >
                      <Bot className="w-3 h-3" />
                      Agent
                    </button>
                  )}
                </div>
                <p className="text-xs font-mono text-muted-foreground break-words">
                  {match.snippet}
                </p>
              </div>
            ))}
        </div>

        {status === 'done' && (
          <p className="text-[11px] text-muted-foreground">
            Scanned {scannedSessions} sessions
            {truncated ? ' (newest first, more matches exist)' : ''}.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
