/**
 * Browser half of the media preview bundle.
 *
 * Registers two document-preview implementations with the shipped
 * `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` registry:
 *   - a video player for common video containers
 *   - an audio player for common audio containers
 *
 * Playback source:
 *   The body asks the Host route `/api/media-preview/transcode?path=...`, which
 *   probes the codec with ffprobe and returns either the original file (when the
 *   codec is browser-playable) or a cached H.264/AAC transcode (e.g. for
 *   HEVC/H.265). The whole response is fetched into a Blob and mounted through
 *   `URL.createObjectURL`, so the element owns the complete file and the progress
 *   bar can seek instantly and reliably (independent of how the Electron custom
 *   protocol handles HTTP Range on a direct <video src>).
 *
 *   If that route is unavailable (older Host without the route), the body falls
 *   back to reading the file in bounded byte windows through
 *   `workspaceFiles.readBytes` and assembling the same kind of Blob, which also
 *   bypasses the document preview's 32 MB single-read cap.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-media-preview',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace shared by the metadata strings and both bodies. */
    const NS = 'dshMediaPreview';

    /** Implementation ids (also the keyed `sidebar.right.tab.document` keys). */
    const VIDEO_ID = '@local/dsh-media-preview/video';
    const AUDIO_ID = '@local/dsh-media-preview/audio';

    const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'ogv', 'mov'];
    const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'];

    const VIDEO_TYPES = {
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      webm: 'video/webm',
      ogv: 'video/ogg',
      mov: 'video/quicktime',
    };
    const AUDIO_TYPES = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      oga: 'audio/ogg',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      flac: 'audio/flac',
      opus: 'audio/ogg',
      weba: 'audio/webm',
    };

    /** Byte window per fallback Remote read; must not exceed the workspace-files page cap (2 MiB default). */
    const CHUNK_BYTES = 1024 * 1024;
    /** Client-side ceiling for the assembled Blob; larger media should use a system player. */
    const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

    const CSS = [
      '.dmp-root{position:absolute;inset:0;box-sizing:border-box;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font,sans-serif);font-size:13px;overflow:hidden}',
      '.dmp-video-frame{box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:12px}',
      '.dmp-video{max-width:100%;max-height:100%;width:auto;height:auto;background:#000;border-radius:calc(var(--dsw-radius-md, 8px) + 2px);outline:none;box-shadow:0 2px 10px rgba(0,0,0,.28);display:block}',
      '.dmp-audio-card{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:16px;width:min(440px,100%);padding:28px 24px;background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);border-radius:calc(var(--dsw-radius-md, 8px) + 4px)}',
      '.dmp-audio-badge{display:flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}',
      '.dmp-audio-badge svg{width:32px;height:32px}',
      '.dmp-audio-name{max-width:100%;text-align:center;font-weight:600;line-height:1.45;word-break:break-all}',
      '.dmp-audio{width:100%;outline:none}',
      '.dmp-status{position:absolute;inset:0;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.dmp-status[data-state="error"]{color:var(--dsw-alias-state-error-primary)}',
    ].join('');

    /** Final filename segment from a path-like string (POSIX or Windows). */
    function baseName(path) {
      if (typeof path !== 'string') return '';
      const trimmed = path.replace(/[/\\]+$/, '');
      const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1;
      return trimmed.slice(cut);
    }

    /** Lowercased suffix after the last dot, or '' when there is none. */
    function extensionOf(name) {
      if (typeof name !== 'string') return '';
      const dot = name.lastIndexOf('.');
      if (dot < 0 || dot === name.length - 1) return '';
      return name.slice(dot + 1).toLowerCase();
    }

    /** Small inline speaker glyph so the audio card reads as audio without artwork. */
    function SpeakerGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M4 9v6h4l5 4V5L8 9H4Z', fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M16.5 8.5a5 5 0 0 1 0 7' }),
        h('path', { d: 'M19 6a8.5 8.5 0 0 1 0 12' }),
      );
    }

    /**
     * Build a media body component for one media kind.
     * @param {'video'|'audio'} kind - which element to mount.
     */
    function createMediaBody(kind) {
      const TYPES = kind === 'video' ? VIDEO_TYPES : AUDIO_TYPES;
      const FALLBACK_MIME = kind === 'video' ? 'video/mp4' : 'audio/mpeg';

      return function MediaBody(props) {
        const t = props.t || ((key) => key);
        const tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
        const tab = tabInfo && tabInfo.tab;
        const name = tab && typeof tab.title === 'string' ? tab.title : '';
        const ext = extensionOf(name) || extensionOf(props.resourceAddress);
        const mime = TYPES[ext] || FALLBACK_MIME;

        const resource = typeof props.useResource === 'function' ? props.useResource(props.resourceAddress) : undefined;
        const value = resource && resource.value;
        const absolutePath = value && typeof value.absolutePath === 'string' ? value.absolutePath : undefined;
        const version = value && value.version;
        const declaredSize = value && typeof value.bytes === 'number' ? value.bytes : undefined;
        const resourceFailed = resource && (resource.status === 'failed' || resource.failure !== undefined);

        const content = props.content;
        const revision = content && content.revision;

        const [state, setState] = React.useState({ status: 'loading' });
        const urlRef = React.useRef(undefined);

        React.useEffect(
          () => () => {
            if (urlRef.current !== undefined) {
              URL.revokeObjectURL(urlRef.current);
              urlRef.current = undefined;
            }
          },
          [],
        );

        React.useEffect(() => {
          if (absolutePath === undefined) return undefined;
          if (declaredSize !== undefined && declaredSize > MAX_TOTAL_BYTES) {
            setState({ status: 'too-large' });
            return undefined;
          }
          let cancelled = false;
          const controller = new AbortController();
          setState({ status: 'loading' });

          const publish = (blob) => {
            if (cancelled) return;
            const url = URL.createObjectURL(blob);
            if (urlRef.current !== undefined) URL.revokeObjectURL(urlRef.current);
            urlRef.current = url;
            setState({ status: 'ready', url });
            if (content && typeof content.loaded === 'function') content.loaded(version);
          };

          (async () => {
            // Primary: authenticated Host route returns a playable (possibly transcoded) file.
            const routePath = `api/media-preview/transcode?path=${encodeURIComponent(absolutePath)}&v=${encodeURIComponent(String(version ?? ''))}`;
            const absUrl = new URL(routePath, document.baseURI).href;
            const transport = globalThis.__DSH_TRANSPORT__;
            try {
              let response;
              if (transport && typeof transport.fetch === 'function') {
                try {
                  response = await transport.fetch(routePath, { signal: controller.signal });
                } catch (transportError) {
                  response = undefined;
                }
              }
              if (response === undefined) {
                response = await fetch(absUrl, { signal: controller.signal });
              }
              if (!response || !response.ok) throw new Error(`media route answered ${response ? response.status : 'no response'}`);
              const blob = await response.blob();
              publish(blob);
              return;
            } catch (error) {
              if (cancelled) return;
              // Fall through to bounded Remote reads when the route is unavailable.
            }

            // Fallback: read the raw file in bounded windows and assemble a Blob.
            try {
              const chunks = [];
              let offset = 0;
              let total = declaredSize;
              let guard = 0;
              for (;;) {
                const result = await props.readBytes(absolutePath, { range: { offset, length: CHUNK_BYTES } }, controller.signal);
                if (cancelled) return;
                if (result && typeof result.bytes === 'number') total = result.bytes;
                const data = result && result.data;
                const length = data && data.byteLength ? data.byteLength : 0;
                if (length > 0) chunks.push(data);
                offset += length;
                if (length === 0 || (result && result.eof === true) || (typeof total === 'number' && offset >= total)) break;
                if (typeof total === 'number' && total > MAX_TOTAL_BYTES) {
                  setState({ status: 'too-large' });
                  return;
                }
                guard += 1;
                if (guard > 200000) break;
              }
              publish(new Blob(chunks, { type: mime }));
            } catch (error) {
              if (cancelled) return;
              if (content && typeof content.failed === 'function') content.failed();
              setState({ status: 'error' });
            }
          })();

          return () => {
            cancelled = true;
            controller.abort();
          };
        }, [absolutePath, declaredSize, mime, version, revision]);

        const shell = (children, extra) =>
          h('div', { className: 'dmp-root', 'data-media-preview': kind }, h('style', null, CSS), children, extra);

        if (absolutePath === undefined) {
          return shell(
            resourceFailed
              ? h('p', { className: 'dmp-status', 'data-state': 'error', role: 'alert' }, t('failed'))
              : h('p', { className: 'dmp-status' }, t('loading')),
          );
        }
        if (state.status === 'too-large') {
          return shell(h('p', { className: 'dmp-status', 'data-state': 'error', role: 'alert' }, t('tooLarge')));
        }
        if (state.status === 'error') {
          return shell(h('p', { className: 'dmp-status', 'data-state': 'error', role: 'alert' }, t('failed')));
        }
        if (state.status === 'codec') {
          return shell(h('p', { className: 'dmp-status', 'data-state': 'error', role: 'alert' }, t('unsupportedCodec')));
        }
        if (state.status !== 'ready' || state.url === undefined) {
          return shell(h('p', { className: 'dmp-status' }, t('loading')));
        }

        const onError = () => setState({ status: 'codec' });
        if (kind === 'video') {
          return shell(
            h(
              'div',
              { className: 'dmp-video-frame' },
              h('video', {
                className: 'dmp-video',
                src: state.url,
                controls: true,
                playsInline: true,
                preload: 'metadata',
                onError,
              }),
            ),
          );
        }
        return shell(
          h(
            'div',
            { className: 'dmp-audio-card' },
            h('div', { className: 'dmp-audio-badge' }, h(SpeakerGlyph, null)),
            h('div', { className: 'dmp-audio-name', title: name || undefined }, name || t('audioTitle')),
            h('audio', {
              className: 'dmp-audio',
              src: state.url,
              controls: true,
              preload: 'metadata',
              onError,
            }),
          ),
        );
      };
    }

    const VideoBody = createMediaBody('video');
    const AudioBody = createMediaBody('audio');

    const DEFINITIONS = [
      { id: VIDEO_ID, extensions: VIDEO_EXTENSIONS, titleKey: 'videoTitle', body: VideoBody },
      { id: AUDIO_ID, extensions: AUDIO_EXTENSIONS, titleKey: 'audioTitle', body: AudioBody },
    ];

    return {
      inject: ['slots', 'locale', 'documentPreviews', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);

        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              en: {
                videoTitle: 'Video',
                audioTitle: 'Audio',
                loading: 'Loading media…',
                failed: 'This media file could not be loaded.',
                tooLarge: 'This media file is too large to preview inline (over 512 MB). Open it in a system app.',
                unsupportedCodec: 'The browser cannot play this file’s audio/video codec. Try opening it in a system app.',
              },
              zh: {
                videoTitle: '视频',
                audioTitle: '音频',
                loading: '正在加载媒体…',
                failed: '无法加载该媒体文件。',
                tooLarge: '该媒体文件过大，无法内嵌预览（超过 512 MB），请用系统应用打开。',
                unsupportedCodec: '浏览器无法播放该文件的音视频编码，建议用系统应用打开。',
              },
            }),
          'media-preview: dictionaries',
        );

        for (const definition of DEFINITIONS) {
          ctx.effect(
            () =>
              ctx.documentPreviews.register({
                id: definition.id,
                extensions: definition.extensions,
                binaryExtensions: definition.extensions,
                priority: 'extension',
                title: () => t(definition.titleKey),
                loading: 'renderer',
                wrap: false,
              }),
            `media-preview: ${definition.id} metadata`,
          );

          ctx.effect(
            () =>
              ctx.slots.inject('sidebar.right.tab.document', () =>
                ctx.slots.register(
                  {
                    name: 'sidebar.right.tab.document',
                    key: definition.id,
                    locale: NS,
                    inject: (sessionId) => ({
                      readBytes: (path, options, signal) => ctx.remote.workspaceFiles.readBytes(sessionId, path, options, signal),
                    }),
                  },
                  definition.body,
                ),
              ),
            `media-preview: ${definition.id} body`,
          );
        }
      },
    };
  },
});
