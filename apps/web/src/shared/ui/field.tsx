import * as LabelPrimitive from '@radix-ui/react-label';
import { useId, type ComponentProps, type ReactNode } from 'react';

import { cn } from '../lib/cn';

const controlStyles =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground aria-[invalid=true]:border-danger';

type FieldProps = {
  label: string;
  /** The validation message for this field; linked to the control with aria-describedby. */
  error?: string | undefined;
  hint?: string;
  /** Receives the props that tie the control to its label and messages. */
  children: (control: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
    className: string;
  }) => ReactNode;
};

/**
 * A labelled form control. The label is bound to the control, and the error text is both
 * announced when it appears (role="alert") and referenced by the control (aria-describedby), so
 * keyboard and screen reader users get the same information as everyone else.
 */
export const Field = ({ label, error, hint, children }: FieldProps) => {
  const id = useId();
  const messageId = `${id}-message`;
  const describedBy = error || hint ? messageId : undefined;
  return (
    <div className="grid gap-1.5">
      <LabelPrimitive.Root htmlFor={id} className="text-sm font-medium">
        {label}
      </LabelPrimitive.Root>
      {children({
        id,
        'aria-invalid': Boolean(error),
        'aria-describedby': describedBy,
        className: controlStyles,
      })}
      {error ? (
        <p id={messageId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
};

export const TextInput = ({ className, ...props }: ComponentProps<'input'>) => (
  <input className={cn(controlStyles, className)} {...props} />
);
export const TextArea = ({ className, ...props }: ComponentProps<'textarea'>) => (
  <textarea className={cn(controlStyles, 'min-h-24', className)} {...props} />
);
