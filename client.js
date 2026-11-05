window.__ModuleLoader__.load({
	id: 'dsh-vpn-guard',
	factory: (require) => {
		const React = require('react');
		const { useCallback, useEffect, useRef, useState } = React;
		const h = React.createElement;

		const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
			+ '<path d="M12 2.2 4.6 5v6.1c0 5.1 3.1 9.2 7.4 10.7 4.3-1.5 7.4-5.6 7.4-10.7V5L12 2.2Z" fill="#0f172a" stroke="#38bdf8" stroke-width="1.6" stroke-linejoin="round"/>'
			+ '<path d="M7.6 12.1h8.8M12 7.7v8.8" stroke="#38bdf8" stroke-width="1.1" opacity="0.45"/>'
			+ '<path d="m8.7 12.5 2.2 2.2 4.4-4.6" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			+ '</svg>';
		const ICON = 'data:image/svg+xml,' + encodeURIComponent(ICON_SVG);

		const token = {
			ok: 'var(--dsw-alias-state-success-primary,#22c55e)',
			warn: 'var(--dsw-alias-state-warn-primary,#eab308)',
			error: 'var(--dsw-alias-state-error-primary,#ef4444)',
			dim: 'var(--dsw-alias-label-dimmed,#64748b)',
			bg: 'var(--dsw-alias-bg-layer-1,#252525)',
			border: 'var(--dsw-alias-border-l2,#4a4a4a)',
			text: 'var(--dsw-alias-label-primary,#f4f4f5)',
			text2: 'var(--dsw-alias-label-secondary,#bdbdbd)',
			accent: 'var(--dsw-alias-brand-primary,#3b82f6)',
			hover: 'var(--dsw-alias-bg-layer-2,#2f2f2f)'
		};

		const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

		// 面板挂在全局浮层 `shell.overlay` 里，不再留在会话头部：DSH 0.2.x 的会话区
		// 祖先节点带 overflow/transform，头部内的 fixed 面板会被裁掉（点开看不见）。
		// 按钮只负责切换这个模块级状态，两半用订阅者同步。
		const panelState = { open: false, listeners: new Set() };
		function setPanelOpen(open) {
			panelState.open = open;
			for (const listener of [...panelState.listeners]) {
				try {
					listener();
				} catch {
					/* 单个订阅者失败不影响其他 */
				}
			}
		}
		function usePanelOpen() {
			const [, force] = useState(0);
			useEffect(() => {
				const listener = () => force((value) => value + 1);
				panelState.listeners.add(listener);
				return () => {
					panelState.listeners.delete(listener);
				};
			}, []);
			return panelState.open;
		}

		function healthText(status) {
			const health = status && status.health;
			if (!health) return '—';
			if (health.skipped) return '未检测';
			if (health.ok) return `通畅（${num(health.ms) ?? '?'}ms）`;
			return '不通';
		}

		function healthColor(status) {
			const health = status && status.health;
			if (!health || health.skipped || health.ok === null) return token.dim;
			return health.ok ? token.ok : token.error;
		}

		function overallColor(status) {
			if (!status) return token.dim;
			const health = status.health || {};
			if (health.ok === false) return token.error;
			if (status.app && status.app.elevated) return token.warn;
			if (status.alert) return token.warn;
			if (status.daemon && status.daemon.running) return token.ok;
			return token.warn;
		}

		function Row(props) {
			return h('div', {
				style: {
					display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 0',
					borderTop: '1px solid ' + token.border, fontSize: 12.5
				}
			},
				h('span', { style: { color: token.text2, flex: '0 0 62px' } }, props.label),
				h('span', {
					style: { color: props.color || token.text, minWidth: 0, overflow: 'hidden',
						textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
				}, props.value));
		}

		function ActionButton(props) {
			const disabled = props.disabled;
			return h('button', {
				onClick: props.onClick,
				disabled,
				title: props.title || props.children,
				style: {
					flex: '1 1 auto', minWidth: 0, padding: '7px 6px', borderRadius: 7,
					border: '1px solid ' + (props.primary ? token.accent : token.border),
					background: props.primary ? token.accent : 'transparent',
					color: props.primary ? '#fff' : token.text,
					fontSize: 12.5, cursor: disabled ? 'default' : 'pointer',
					opacity: disabled ? 0.5 : 1
				}
			}, props.children);
		}

		function App() {
			const [status, setStatus] = useState(null);
			const [action, setAction] = useState(null);
			const open = usePanelOpen();
			const [error, setError] = useState(null);
			const [toast, setToast] = useState(null);
			const [showLog, setShowLog] = useState(false);
			const [logText, setLogText] = useState('');
			const [requesting, setRequesting] = useState(false);
			const actionRef = useRef(null);

			const toastTimer = useRef(0);
			const notify = useCallback((text) => {
				setToast(text);
				window.clearTimeout(toastTimer.current);
				toastTimer.current = window.setTimeout(() => setToast(null), 6000);
			}, []);

			useEffect(() => () => window.clearTimeout(toastTimer.current), []);

			const load = useCallback(async (fast) => {
				try {
					const response = await fetch('/vpn-guard/status' + (fast ? '?fast=1' : ''), {
						signal: AbortSignal.timeout(fast ? 20000 : 45000)
					});
					const data = await response.json();
					if (!data || !data.ok || !data.status) throw new Error('bad payload');
					setStatus(data.status);
					const nextAction = data.action || null;
					const previous = actionRef.current;
					actionRef.current = nextAction;
					setAction(nextAction);
					setError(null);
					if (previous && previous.running && nextAction && !nextAction.running) {
						notify(nextAction.message || (nextAction.ok ? '操作完成' : '操作失败'));
						if (nextAction.output) setShowLog(true);
					}
				} catch {
					setError('读取状态失败（检查守护工具是否可用）');
				}
			}, [notify]);

			useEffect(() => {
				void load(true);
				const timer = window.setInterval(() => void load(true), 25000);
				return () => window.clearInterval(timer);
			}, [load]);

			useEffect(() => {
				if (!open) return undefined;
				void load(false);
				const timer = window.setInterval(() => void load(false), 12000);
				return () => window.clearInterval(timer);
			}, [open, load]);

			useEffect(() => {
				if (!open) return undefined;
				const onKey = (event) => { if (event.key === 'Escape') setPanelOpen(false); };
				window.addEventListener('keydown', onKey);
				return () => window.removeEventListener('keydown', onKey);
			}, [open]);

			useEffect(() => {
				if (!(action && action.running)) return undefined;
				const timer = window.setInterval(async () => {
					try {
						const response = await fetch('/vpn-guard/action', { signal: AbortSignal.timeout(15000) });
						const data = await response.json();
						const nextAction = data.action || null;
						const previous = actionRef.current;
						actionRef.current = nextAction;
						setAction(nextAction);
						if (previous && previous.running && nextAction && !nextAction.running) {
							notify(nextAction.message || (nextAction.ok ? '操作完成' : '操作失败'));
							if (nextAction.output) setShowLog(true);
							void load(false);
						}
					} catch {
						/* 轮询失败就等下一轮 */
					}
				}, 1500);
				return () => window.clearInterval(timer);
			}, [action && action.running, load, notify]);

			const runAction = useCallback(async (name) => {
				if (requesting || (action && action.running)) return;
				setRequesting(true);
				try {
					const response = await fetch('/vpn-guard/action', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action: name }),
						signal: AbortSignal.timeout(20000)
					});
					const data = await response.json().catch(() => ({}));
					if (!response.ok || !data.ok) {
						notify(data.message || data.error || '操作没有开始');
						return;
					}
					actionRef.current = data.action || null;
					setAction(data.action || null);
					notify(`已开始：${data.action ? data.action.title : name}`);
				} catch {
					notify('操作请求失败，请稍后重试');
				} finally {
					setRequesting(false);
				}
			}, [action, requesting, notify]);

			const loadLog = useCallback(async () => {
				try {
					const response = await fetch('/vpn-guard/log?lines=80', { signal: AbortSignal.timeout(15000) });
					const data = await response.json();
					setLogText(String(data.text || ''));
				} catch {
					setLogText('读取日志失败');
				}
			}, []);

			useEffect(() => { if (showLog) void loadLog(); }, [showLog, loadLog]);

			const dotColor = overallColor(status);
			const busy = requesting || Boolean(action && action.running);
			const elevated = Boolean(status && status.app && status.app.elevated);

			if (!open) return null;

			const rows = [];
			if (status) {
				rows.push(h(Row, { key: 'daemon', label: '守护',
					value: status.daemon && status.daemon.running
						? `运行中（PID ${status.daemon.pid}）` : '未运行',
					color: status.daemon && status.daemon.running ? token.ok : token.warn }));
				rows.push(h(Row, { key: 'app', label: 'v2rayN',
					value: status.app && status.app.running ? `运行中 v${status.app.version || '?'}` : '未运行',
					color: status.app && status.app.running ? token.ok : token.error }));
				if (elevated) {
					rows.push(h(Row, { key: 'elevated', label: '权限',
						value: '⚠ 以管理员身份运行，助手无法控制它', color: token.warn }));
				}
				if (status.node) {
					const node = status.node;
					const suffix = status.core && status.core.core ? ` · ${status.core.core}` : '';
					rows.push(h(Row, { key: 'node', label: '当前节点',
						value: `${node.name}${suffix}` }));
				}
				rows.push(h(Row, { key: 'health', label: '网络',
					value: healthText(status), color: healthColor(status) }));
				if (status.subscription) {
					const age = num(status.subscription.ageHours);
					rows.push(h(Row, { key: 'sub', label: '订阅',
						value: age === null ? '—' : `${age.toFixed(1)} 小时前更新` }));
				}
				if (status.nodes) {
					rows.push(h(Row, { key: 'nodes', label: '可用节点',
						value: `${status.nodes.usable ?? '?'} / ${status.nodes.total ?? '?'}` }));
				}
				if (status.policy) {
					rows.push(h(Row, { key: 'policy', label: '切换策略', value: status.policy.label }));
				}
				if (status.alert && status.alert.message) {
					rows.push(h('div', {
						key: 'alert',
						style: { marginTop: 8, padding: '7px 9px', borderRadius: 7,
							background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
							color: token.text, fontSize: 12, lineHeight: 1.5 }
					}, h('b', { style: { color: token.error } }, '需要处理：'), status.alert.message));
				}
			}

			const actionLine = action ? h('div', {
				style: { marginTop: 8, fontSize: 12, color: action.running ? token.warn : (action.ok ? token.ok : token.error) }
			},
				action.running ? `正在执行：${action.title}…` : `${action.title}：${action.message || (action.ok ? '完成' : '失败')}`,
				action.output ? h('pre', {
					style: { margin: '6px 0 0', padding: '6px 8px', maxHeight: 120, overflow: 'auto',
						background: 'rgba(0,0,0,0.25)', borderRadius: 6, color: token.text2,
						fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre-wrap' }
				}, action.output) : null) : null;

			const panel = h('div', {
				style: {
					position: 'fixed', zIndex: 1000, width: 392, right: 18, top: 62,
					background: token.bg, border: '1px solid ' + token.border, borderRadius: 12,
					padding: 14, boxShadow: '0 18px 45px #0008', color: token.text, fontSize: 13
				},
				role: 'dialog',
				'aria-label': 'VPN 守护'
			},
				h('button', {
					onClick: () => setPanelOpen(false),
					'aria-label': '关闭',
					style: { float: 'right', background: 'transparent', border: 0, color: token.text2,
						fontSize: 19, cursor: 'pointer', lineHeight: 1 }
				}, '×'),
				h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 } },
					h('img', { src: ICON, alt: '', style: { width: 18, height: 18 } }),
					'VPN 守护（v2rayN）'),
				h('div', { style: { color: token.text2, fontSize: 12, marginTop: 4 } },
					'节点坏了自动换、订阅定时刷新；不自动开机启动。'),
				error ? h('div', { style: { marginTop: 8, fontSize: 12, color: token.error } }, error) : null,
				status ? h('div', { style: { marginTop: 8 } }, rows) : h('div', { style: { marginTop: 10, color: token.text2 } }, '正在读取状态…'),
				h('div', { style: { display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' } },
					h(ActionButton, { onClick: () => void runAction('fix'), disabled: busy, primary: true }, busy ? '执行中…' : '一键修复'),
					h(ActionButton, { onClick: () => void runAction('start'), disabled: busy || Boolean(status && status.daemon && status.daemon.running) }, '启动守护'),
					h(ActionButton, { onClick: () => void runAction('stop'), disabled: busy || !(status && status.daemon && status.daemon.running) }, '停止守护'),
					h(ActionButton, { onClick: () => void runAction('refresh'), disabled: busy }, '刷新订阅')),
				actionLine,
				h('div', { style: { display: 'flex', gap: 12, marginTop: 10, fontSize: 12 } },
					h('button', {
						onClick: () => { void load(false); notify('已刷新'); },
						style: { background: 'transparent', border: 0, color: token.accent, cursor: 'pointer', padding: 0 }
					}, '刷新状态'),
					h('button', {
						onClick: () => setShowLog((value) => !value),
						style: { background: 'transparent', border: 0, color: token.text2, cursor: 'pointer', padding: 0 }
					}, showLog ? '收起日志' : '看日志')),
				showLog ? h('pre', {
					style: { margin: '8px 0 0', padding: '7px 8px', maxHeight: 170, overflow: 'auto',
						background: 'rgba(0,0,0,0.25)', borderRadius: 7, color: token.text2,
						fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre-wrap' }
				}, logText || '加载中…') : null);

			const toastEl = toast ? h('div', {
				style: { position: 'fixed', zIndex: 1001, right: 22, top: 16, padding: '8px 12px',
					borderRadius: 8, background: token.bg, border: '1px solid ' + token.border,
					color: token.text, fontSize: 13, boxShadow: '0 8px 24px #0008', maxWidth: 320 }
			}, toast) : null;

			return h(React.Fragment, null, panel, toastEl);
		}

		/**
		 * 会话头部的「VPN」按钮：只负责切换面板和显示健康点，不再渲染面板本体。
		 * 面板在 shell.overlay 的 App 里按同一个 store 的 open 状态渲染。
		 */
		function HeaderToggle() {
			const open = usePanelOpen();
			const [status, setStatus] = useState(null);

			useEffect(() => {
				let alive = true;
				const load = async () => {
					try {
						const response = await fetch('/vpn-guard/status?fast=1', { signal: AbortSignal.timeout(20000) });
						const data = await response.json();
						if (alive && data && data.ok) setStatus(data.status);
					} catch {
						/* 状态读不到就保持上一个点色 */
					}
				};
				void load();
				const timer = window.setInterval(load, 25000);
				return () => {
					alive = false;
					window.clearInterval(timer);
				};
			}, []);

			return h('button', {
				onClick: () => setPanelOpen(!open),
				title: 'VPN 守护（v2rayN 订阅 / 节点）',
				'aria-label': 'VPN 守护',
				style: {
					display: 'inline-flex', alignItems: 'center', gap: 5, border: 0,
					background: open ? 'var(--dsw-alias-interactive-bg-hover, transparent)' : 'transparent',
					color: 'inherit', fontSize: 12, cursor: 'pointer',
					padding: '2px 4px', borderRadius: 6
				}
			},
				h('img', { src: ICON, alt: '', style: { width: 16, height: 16 } }),
				h('span', null, 'VPN'),
				h('i', { style: { width: 7, height: 7, borderRadius: '50%', background: overallColor(status) } }));
		}

		const inject = ['slots'];
		function apply(ctx) {
			ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
				name: 'conversation.session.header.actions',
				id: 'vpn-guard-header',
				order: 23
			}, HeaderToggle));
			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'vpn-guard-panel',
				order: 130
			}, App));
		}

		return { name: 'dsh-vpn-guard', inject, apply };
	}
});

