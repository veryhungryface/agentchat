import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function ChatMessage({ message, isStreaming }) {
  const isUser = message.role === 'user';

  return (
    <article className={`message ${isUser ? 'message-user' : 'message-assistant'} ${message.isError ? 'message-error' : ''}`}>
      {!isUser && (
        <div className="assistant-meta">
          <span className="assistant-meta-logo" aria-hidden="true">✺</span>
          <span className="assistant-meta-name">
            manus <span className="assistant-meta-tier">Lite</span>
          </span>
        </div>
      )}

      <div className="message-content">
        {message.content ? (
          isUser ? message.content : (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          )
        ) : isStreaming ? (
          <span className="cursor-blink" />
        ) : null}
      </div>
    </article>
  );
}

export default ChatMessage;
