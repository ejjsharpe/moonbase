import { forwardRef, type ReactNode } from 'react';
import { motion, useIsPresent, useReducedMotion, type HTMLMotionProps } from 'motion/react';

type Props = Omit<HTMLMotionProps<'div'>, 'children'> & {
  children(present: boolean): ReactNode;
};

export const AnimatedTab = forwardRef<HTMLDivElement, Props>(function AnimatedTab(
  { children, ...props },
  ref,
) {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      {...props}
      ref={ref}
      layout={reducedMotion ? false : 'position'}
      initial={{ opacity: 0, x: reducedMotion ? 0 : -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{
        opacity: 0,
        x: reducedMotion ? 0 : -10,
        transition: { duration: reducedMotion ? 0.08 : 0.14 },
      }}
      transition={{ duration: reducedMotion ? 0.08 : 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      inert={!present}
      aria-hidden={present ? undefined : true}>
      {children(present)}
    </motion.div>
  );
});
